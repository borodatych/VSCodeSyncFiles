import * as path from "node:path";
import * as vscode from "vscode";
import type { DeferredQueueItem, SyncScheduleDeferredStore } from "../core/syncScheduleDeferredStore.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { fileLooksBinary } from "../utils/binaryDetect.js";
import {
  binarySkipMessage,
  shouldAnnounceBinarySkip,
} from "../core/binarySkipNotice.js";
import { runQuietFullSyncAllFolders, type QuietFullSyncAllFoldersDeps } from "./quietFullSyncAllFolders.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";

const CFG = "vscodesync";

export type ScheduleDeferredFlushDeps = QuietFullSyncAllFoldersDeps;

/** Executes drained deferred ops after entering schedule window or manual flush. */
export async function flushScheduleDeferredQueue(
  store: SyncScheduleDeferredStore,
  deps: ScheduleDeferredFlushDeps,
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }

  const snapshot = await store.drainSnapshot();
  if (snapshot.length === 0) {
    return;
  }

  if (isAutoSyncBlockedByRateLimit()) {
    await store.prependItems(snapshot);
    return;
  }

  const hadFull = snapshot.some((i) => i.kind === "fullSync");
  if (hadFull) {
    await runQuietFullSyncAllFolders({ ...deps, bypassSchedule: true, bypassAutoPause: true });
    void vscode.window.showInformationMessage("VSCodeSync: выполнены отложенные синхронизации (полный sync).");
    return;
  }

  const provider = await deps.tryAuthenticatedProvider();
  if (!provider) {
    await store.prependItems(snapshot);
    return;
  }

  const mc = await deps.globalConfig.load();

  const fileOps = snapshot.filter((i): i is Exclude<DeferredQueueItem, { kind: "fullSync" }> => i.kind !== "fullSync");

  deps.statusBar.setSyncing(true);
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
          if (shouldAnnounceBinarySkip(root, item.rel)) {
            void vscode.window.showWarningMessage(binarySkipMessage(item.rel));
          }
          continue;
        }
        try {
          await engine.pushFile(cfg, item.workspaceId, item.rel, entry);
          await WorkspaceConfigManager.save(cfg, root);
        } catch {
          /* best-effort per deferred item */
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
  } finally {
    deps.statusBar.setSyncing(false);
    deps.refreshUi();
    await deps.statusBar.refresh();
  }

  const n = snapshot.length;
  void vscode.window.showInformationMessage(`VSCodeSync: выполнены отложенные синхронизации (${String(n)} операций).`);
}
