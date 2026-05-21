import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { isCloudConnectivityOffline } from "./connectivityProbeWidget.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { isLikelyUnreachableError } from "../utils/networkErrors.js";
import { isAutoSyncBlockedBySchedule } from "./syncScheduleGate.js";
import {
  isAutoCheckEnabled,
  isAutoFullSyncEnabled,
  parseAutoSyncMode,
} from "../core/autoSyncMode.js";
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
 *
 * v0.7 — when the global `vscodesync.autoSyncMode` setting is `check-only`,
 * the per-workspace pass calls `engine.checkWorkspaceStatus` instead of
 * `engine.syncWorkspace` — statuses are updated but no file moves.
 * When `off`, the function returns immediately without any work.
 *
 * Callers that need to bypass the gate (manual user-driven sync,
 * deferred-flush, webhook-driven sync) should pass `bypassAutoSyncMode: true`.
 */
export async function runQuietFullSyncAllFolders(d: QuietFullSyncAllFoldersDeps & { bypassAutoSyncMode?: boolean }): Promise<boolean> {
  if (!vscode.workspace.isTrusted) {
    return false;
  }
  const autoMode = parseAutoSyncMode(
    vscode.workspace.getConfiguration("vscodesync").get<string>("autoSyncMode", "check-only"),
  );
  const allowFull = d.bypassAutoSyncMode === true || isAutoFullSyncEnabled(autoMode);
  const allowCheck = d.bypassAutoSyncMode === true || isAutoCheckEnabled(autoMode);
  if (!allowCheck) {
    return false;
  }
  if (!d.bypassRateLimit && isAutoSyncBlockedByRateLimit()) {
    return false;
  }
  // v0.18 W5 — skip silently when the connectivity probe says we're
  // offline. Manual user-driven sync calls pass `bypassRateLimit` and
  // also bypass this check.
  if (!d.bypassRateLimit && isCloudConnectivityOffline()) {
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
        if (allowFull) {
          await engine.syncWorkspace(aw.workspaceId);
        } else {
          // check-only: update sync statuses, but no push/pull happens.
          await engine.checkWorkspaceStatus(aw.workspaceId);
        }
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
