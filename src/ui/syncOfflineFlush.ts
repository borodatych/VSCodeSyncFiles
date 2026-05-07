import * as path from "node:path";
import * as vscode from "vscode";
import type { OfflineQuickTransferQueueItem, OfflineQueueItem, SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { fileLooksBinary } from "../utils/binaryDetect.js";
import { runQuietFullSyncAllFolders, type QuietFullSyncAllFoldersDeps } from "./quietFullSyncAllFolders.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { isAutoSyncBlockedBySchedule } from "./syncScheduleGate.js";
import { noteCloudTransportFailure, noteCloudTransportSuccess } from "../core/syncOfflineHints.js";
import {
  allowImmediateOfflineFlushRetry,
  bumpOfflineFlushBackoff,
  resetOfflineFlushBackoff,
} from "../core/syncOfflineFlushBackoff.js";
import { isQueuedQuickTransferSendExpired, sendQuickTransferFile } from "../core/quickTransfer.js";
import { isLikelyUnreachableError } from "../utils/networkErrors.js";

const CFG = "vscodesync";

export type OfflineFlushDeps = QuietFullSyncAllFoldersDeps;

/**
 * Drain and execute persisted offline queue after transport recovers.
 */
export async function flushOfflineQueue(store: SyncOfflineQueueStore, deps: OfflineFlushDeps): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }

  if (isAutoSyncBlockedByRateLimit()) {
    return;
  }
  if (isAutoSyncBlockedBySchedule()) {
    return;
  }

  const snapshot = await store.drainSnapshot();
  if (snapshot.length === 0) {
    return;
  }

  const hadFull = snapshot.some((i) => i.kind === "fullSync");
  if (hadFull) {
    await runQuietFullSyncAllFolders({
      ...deps,
      bypassSchedule: true,
      bypassAutoPause: true,
      bypassRateLimit: true,
    });
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
  try {
    for (const item of fileOps) {
      const root = item.root;
      const engine = deps.makeEngine(root, provider, mc.machineId, mc.machineName);
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
        const abs = path.join(root, ...item.rel.split("/"));
        if (warnBin && (await fileLooksBinary(abs))) {
          continue;
        }
        try {
          await engine.pushFile(cfg, item.workspaceId, item.rel, entry);
          await WorkspaceConfigManager.save(cfg, root);
        } catch {
          /* best-effort */
        }
      } else {
        try {
          await engine.pullFile(cfg, item.workspaceId, item.rel, entry);
          await WorkspaceConfigManager.save(cfg, root);
        } catch {
          /* best-effort */
        }
      }
    }

    for (let i = 0; i < activeQt.length; i++) {
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

  if (abortedQtForNetwork) {
    return;
  }

  resetOfflineFlushBackoff();
  noteCloudTransportSuccess();
  const n = tail.length + (hadFull ? 1 : 0);
  void vscode.window.showInformationMessage(`VSCodeSync: оффлайн-очередь — обработано элементов: ${String(n)}.`);
}
