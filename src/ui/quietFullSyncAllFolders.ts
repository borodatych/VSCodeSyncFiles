import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
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
  makeEngine: (root: string, provider: ICloudProvider, machineId: string, machineName: string, trigger: SyncTrigger) => SyncEngine;
  statusBar: { setSyncing: (on: boolean) => void; refresh: () => Promise<void> };
  refreshUi: () => void;
  /** When set, full sync failures from transport errors enqueue for later flush. */
  offlineQueue?: SyncOfflineQueueStore;
  /**
   * Who asked. Required, like every other trigger declaration — the four
   * `bypass*` parameters this replaces were optional, so forgetting one silently
   * meant "obey the gates" while passing one silently meant "ignore them", and
   * nothing in the type said which callers were entitled to do that.
   */
  trigger: SyncTrigger;
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
 * The four `bypass*` parameters this used to carry are gone: policy that an
 * argument can disable is not policy. Every one of them meant the same thing —
 * "a human asked for this, so the automatic gates do not apply" — and that is
 * now said once, by `trigger`. `bypassAutoSyncMode` was in fact passed by
 * nobody at all; its intent ("a manual sync forces a full pass even in
 * check-only mode") survives as the `trigger === "user"` branch below.
 */
export async function runQuietFullSyncAllFolders(d: QuietFullSyncAllFoldersDeps): Promise<boolean> {
  if (!vscode.workspace.isTrusted) {
    return false;
  }
  const byUser = d.trigger === "user";
  const autoMode = parseAutoSyncMode(
    vscode.workspace.getConfiguration("vscodesync").get<string>("autoSyncMode", "check-only"),
  );
  const allowFull = byUser || isAutoFullSyncEnabled(autoMode);
  if (!byUser && !isAutoCheckEnabled(autoMode)) {
    return false;
  }
  if (!byUser && isAutoSyncBlockedByRateLimit()) {
    return false;
  }
  // v0.18 W5 — skip silently when the connectivity probe says we're offline.
  if (!byUser && isCloudConnectivityOffline()) {
    return false;
  }
  if (!byUser && isAutoSyncBlockedBySchedule()) {
    return false;
  }
  if (!byUser && syncAutoPause.isActive()) {
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
      const engine = d.makeEngine(folder.uri.fsPath, p, mc.machineId, mc.machineName, d.trigger);
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
