import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { isLikelyUnreachableError } from "../utils/networkErrors.js";
import { isAutoSyncBlockedBySchedule } from "./syncScheduleGate.js";
import {
  allowImmediateOfflineFlushRetry,
  bumpOfflineFlushBackoff,
} from "../core/syncOfflineFlushBackoff.js";
import { noteCloudTransportFailure } from "../core/syncOfflineHints.js";
import { verboseLog } from "../utils/log.js";

export interface QuietFullSyncAllFoldersDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  makeEngine: (root: string, provider: ICloudProvider, machineId: string, machineName: string) => SyncEngine;
  statusBar: { setSyncing: (on: boolean) => void; refresh: () => Promise<void> };
  refreshUi: () => void;
  /** When true, ignore `syncSchedule` automatic blocking (manual sync / deferred flush). */
  bypassSchedule?: boolean;
  /** When true, ignore metered/battery auto-pause (explicit manual sync). */
  bypassAutoPause?: boolean;
  /** When set, full sync failures from transport errors enqueue for later flush. */
  offlineQueue?: SyncOfflineQueueStore;
  /** When true, allow full sync even when rate-limited (manual / webhook path). */
  bypassRateLimit?: boolean;
}

/**
 * Full sync (`syncWorkspace` per active id) for every workspace folder that has VSCodeSync workspaces. Errors swallowed.
 * Returns `true` if any file was pushed or pulled (changes detected), `false` if fully idle.
 */
export async function runQuietFullSyncAllFolders(d: QuietFullSyncAllFoldersDeps): Promise<boolean> {
  if (!vscode.workspace.isTrusted) {
    return false;
  }
  if (!d.bypassRateLimit && isAutoSyncBlockedByRateLimit()) {
    return false;
  }
  if (!d.bypassSchedule && isAutoSyncBlockedBySchedule()) {
    return false;
  }
  if (!d.bypassAutoPause && syncAutoPause.isActive()) {
    return false;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const p = await d.tryAuthenticatedProvider();
  if (!p) {
    return false;
  }
  const mc = await d.globalConfig.load();
  // Snapshot lastSync values before sync to detect changes
  const beforeSnapshots = new Map<string, string>();
  for (const folder of folders) {
    try {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      for (const f of wc.files) {
        beforeSnapshots.set(`${folder.uri.fsPath}:${f.workspaceId}:${f.localPath}`, f.lastSync);
      }
    } catch { /* non-fatal */ }
  }
  verboseLog("quietFullSync", `setSyncing(true) folders=${String(folders.length)}`);
  d.statusBar.setSyncing(true);
  try {
    for (const folder of folders) {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      if (wc.activeWorkspaces.length === 0) {
        continue;
      }
      const engine = d.makeEngine(folder.uri.fsPath, p, mc.machineId, mc.machineName);
      const fresh = await WorkspaceConfigManager.load(folder.uri.fsPath);
      for (const aw of fresh.activeWorkspaces) {
        await engine.syncWorkspace(aw.workspaceId);
      }
    }
  } catch (e: unknown) {
    if (d.offlineQueue && isLikelyUnreachableError(e)) {
      await d.offlineQueue.enqueueFullSync();
      allowImmediateOfflineFlushRetry();
      bumpOfflineFlushBackoff();
      noteCloudTransportFailure();
    }
  } finally {
    verboseLog("quietFullSync", "finally");
    d.statusBar.setSyncing(false);
    d.refreshUi();
    await d.statusBar.refresh();
  }
  // Detect changes: compare lastSync values after sync
  let changed = false;
  for (const folder of folders) {
    try {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      for (const f of wc.files) {
        const key = `${folder.uri.fsPath}:${f.workspaceId}:${f.localPath}`;
        if (f.lastSync !== (beforeSnapshots.get(key) ?? "")) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    } catch { /* non-fatal */ }
  }
  return changed;
}
