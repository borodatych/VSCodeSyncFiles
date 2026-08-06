import * as vscode from "vscode";
import type { OfflineQuickTransferQueueItem, OfflineQueueItem, SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { warnLog } from "../utils/log.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { fileLooksBinary } from "../utils/binaryDetect.js";
import {
  binarySkipMessage,
  shouldAnnounceBinarySkip,
} from "../core/binarySkipNotice.js";
import { runQuietFullSyncAllFolders, type QuietFullSyncAllFoldersDeps } from "./quietFullSyncAllFolders.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { noteCloudTransportFailure, noteCloudTransportSuccess } from "../core/syncOfflineHints.js";
import {
  allowImmediateOfflineFlushRetry,
  bumpOfflineFlushBackoff,
  resetOfflineFlushBackoff,
} from "../core/syncOfflineFlushBackoff.js";
import { isQueuedQuickTransferSendExpired, sendQuickTransferFile } from "../core/quickTransfer.js";
import { isLikelyUnreachableError } from "../utils/networkErrors.js";
import { trackedAbsolutePathFor } from "../core/trackedPathResolver.js";

const CFG = "vscodesync";

export type OfflineFlushDeps = QuietFullSyncAllFoldersDeps;

/**
 * Drain and execute the persisted offline queue.
 *
 * Since B2 this is a *user* action: the recovery monitor only counts pending
 * items and offers a notification, and the deps carry `trigger: "user"` from
 * the button press. The rate-limit gate below applies to what is
 * still an automatic environment signal (they stop a user click from landing
 * into a rate-limited provider), but nothing calls this on a timer any more.
 */
export async function flushOfflineQueue(store: SyncOfflineQueueStore, deps: OfflineFlushDeps): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }

  if (isAutoSyncBlockedByRateLimit()) {
    return;
  }

  const snapshot = await store.drainSnapshot();
  if (snapshot.length === 0) {
    return;
  }

  const hadFull = snapshot.some((i) => i.kind === "fullSync");
  if (hadFull) {
    await runQuietFullSyncAllFolders(deps);
  }

  const tail = snapshot.filter((i) => i.kind !== "fullSync");

  const fileOps: Exclude<OfflineQueueItem, { kind: "fullSync" | "quickTransferSend" }>[] = [];
  const activeQt: OfflineQuickTransferQueueItem[] = [];
  for (const i of tail) {
    if (i.kind === "quickTransferSend") {
      if (isQueuedQuickTransferSendExpired(i.queuedAtIso, i.ttlDays)) {
        void vscode.window.showWarningMessage(
          `VSCodeSync: Quick Transfer снят с оффлайн-очереди — истёк срок (${i.projectRelativePosix}).`,
        );
      } else {
        activeQt.push(i);
      }
    } else {
      fileOps.push(i);
    }
  }

  if (fileOps.length === 0 && activeQt.length === 0) {
    if (hadFull) {
      resetOfflineFlushBackoff();
      noteCloudTransportSuccess();
      void vscode.window.showInformationMessage("VSCodeSync: оффлайн-очередь — выполнен полный sync.");
    }
    return;
  }

  const provider = await deps.tryAuthenticatedProvider();
  if (!provider) {
    await store.prependItems([...fileOps, ...activeQt]);
    return;
  }

  const mc = await deps.globalConfig.load();

  deps.statusBar.setSyncing(true);
  let abortedQtForNetwork = false;
  // The queue is drained *before* anything runs, so an item whose operation
  // fails is simply gone: the old code swallowed every file-op error with
  // `catch { /* best-effort */ }`, the user was told "processed N items", and
  // the work was never retried. Failures are collected here and put back.
  const failedOps: OfflineQueueItem[] = [];
  let abortedOpsForNetwork = false;
  try {
    for (let opIx = 0; opIx < fileOps.length; opIx += 1) {
      const item = fileOps[opIx];
      const root = item.root;
      const engine = deps.makeEngine(root, provider, mc.machineId, mc.machineName, deps.trigger);
      const cfg = await WorkspaceConfigManager.load(root);
      const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === item.workspaceId);
      if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
        continue;
      }
      const fe = cfg.files.find((f) => f.localPath === item.rel && f.workspaceId === item.workspaceId);
      if (!fe || fe.syncStatus === "conflict") {
        continue;
      }

      if (item.kind === "push") {
        const warnBin = vscode.workspace.getConfiguration(CFG).get<boolean>("warnOnBinaryFiles", true);
        const abs = await trackedAbsolutePathFor(root, item.rel);
        if (abs === undefined) continue;
        if (warnBin && (await fileLooksBinary(abs))) {
          if (shouldAnnounceBinarySkip(root, item.rel)) {
            void vscode.window.showWarningMessage(binarySkipMessage(item.rel));
          }
          continue;
        }
        try {
          await engine.pushFile(cfg, item.workspaceId, item.rel, entry);
          await WorkspaceConfigManager.save(cfg, root);
        } catch (e) {
          if (isLikelyUnreachableError(e)) {
            // Network is gone again: keep this item and everything after it.
            await store.prependItems(fileOps.slice(opIx));
            bumpOfflineFlushBackoff();
            allowImmediateOfflineFlushRetry();
            noteCloudTransportFailure();
            abortedOpsForNetwork = true;
            break;
          }
          failedOps.push(item);
          warnLog("offlineFlush", `push ${item.rel}: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        try {
          await engine.pullFile(cfg, item.workspaceId, item.rel, entry);
          await WorkspaceConfigManager.save(cfg, root);
        } catch (e) {
          if (isLikelyUnreachableError(e)) {
            await store.prependItems(fileOps.slice(opIx));
            bumpOfflineFlushBackoff();
            allowImmediateOfflineFlushRetry();
            noteCloudTransportFailure();
            abortedOpsForNetwork = true;
            break;
          }
          failedOps.push(item);
          warnLog("offlineFlush", `pull ${item.rel}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    for (let i = 0; i < activeQt.length && !abortedOpsForNetwork; i++) {
      const qt = activeQt[i];
      try {
        await sendQuickTransferFile(provider, {
          machineId: mc.machineId,
          machineName: mc.machineName,
          ttlDays: qt.ttlDays,
          absolutePath: qt.absolutePath,
          projectRelativePosix: qt.projectRelativePosix,
          targetMachineId: qt.targetMachineId,
          maxFileSizeBytes: qt.maxFileSizeBytes,
        });
        void vscode.window.showInformationMessage(
          `VSCodeSync: Quick Transfer отправлен после восстановления сети: ${qt.projectRelativePosix}`,
        );
      } catch (e) {
        if (isLikelyUnreachableError(e)) {
          await store.prependItems(activeQt.slice(i));
          bumpOfflineFlushBackoff();
          allowImmediateOfflineFlushRetry();
          noteCloudTransportFailure();
          abortedQtForNetwork = true;
          break;
        }
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(`VSCodeSync Quick Transfer (очередь): ${msg}`);
      }
    }
  } finally {
    deps.statusBar.setSyncing(false);
    deps.refreshUi();
    await deps.statusBar.refresh();
  }

  if (abortedQtForNetwork || abortedOpsForNetwork) {
    return;
  }

  // Items that failed for a non-network reason go back into the queue instead
  // of disappearing. They are appended, not prepended, so a permanently broken
  // item cannot starve the rest of the queue on every flush.
  if (failedOps.length > 0) {
    await store.prependItems(failedOps);
    void vscode.window.showWarningMessage(
      `VSCodeSync: оффлайн-очередь — не удалось выполнить элементов: ${String(failedOps.length)}. ` +
        "Они возвращены в очередь, подробности — в канале Diagnostics.",
    );
  }

  resetOfflineFlushBackoff();
  noteCloudTransportSuccess();
  const processed = tail.length + (hadFull ? 1 : 0) - failedOps.length;
  void vscode.window.showInformationMessage(
    `VSCodeSync: оффлайн-очередь — обработано элементов: ${String(processed)}.`,
  );
}
