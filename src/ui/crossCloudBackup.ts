/**
 * Cross-cloud backup mirror — periodically copy `_meta.json`, all manifests
 * and the `.history/` of every active workspace from the primary cloud
 * provider to a secondary one. Off by default; opt-in via
 * `vscodesync.backup.secondaryProvider` + `vscodesync.backup.intervalDays`.
 *
 * Runs in the same process: at startup we schedule the next due moment and
 * fire a single `runOnce` call which iterates over every active workspace
 * folder. No retries / partial-progress — failures are logged via `warnLog`
 * and the next attempt happens after the next interval.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { ProviderType } from "../core/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import {
  CLOUD_ROOT_DIR,
  manifestCloudPath,
  metaCloudPath,
  historyDirForFile,
  snapshotsDirForWorkspace,
  workspaceRootPath,
} from "../core/cloudLayout.js";
import { warnLog, verboseLog } from "../utils/log.js";

const STATE_KEY = "vscodesync.backup.lastRunMs";
const STARTUP_DELAY_MS = 90_000; // 90 s after activate
const POLL_INTERVAL_MS = 30 * 60_000; // 30 min — far below the daily granularity

export interface CrossCloudBackupDeps {
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  /** Returns the active (primary) provider, null if not authenticated. */
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
}

export function registerCrossCloudBackup(
  context: vscode.ExtensionContext,
  deps: CrossCloudBackupDeps,
): void {
  // Mirror operations may iterate hundreds of cloud objects and easily
  // exceed POLL_INTERVAL_MS in tail latency. Without the running flag a
  // second tick would interleave uploads on the same secondary provider.
  let running = false;
  const guarded = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await tick(context, deps);
      } finally {
        running = false;
      }
    })();
  };
  const initial = setTimeout(guarded, STARTUP_DELAY_MS);
  const interval = setInterval(guarded, POLL_INTERVAL_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => { clearTimeout(initial); }),
    new vscode.Disposable(() => { clearInterval(interval); }),
  );
}

async function tick(context: vscode.ExtensionContext, deps: CrossCloudBackupDeps): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("vscodesync");
  const secondary = cfg.get<string>("backup.secondaryProvider", "");
  const intervalDays = cfg.get<number>("backup.intervalDays", 7);
  if (!secondary || !isProviderType(secondary)) return;
  if (intervalDays < 1) return;

  const last = context.globalState.get<number>(STATE_KEY) ?? 0;
  const due = intervalDays * 24 * 3600_000;
  if (Date.now() - last < due) return;

  // The interval is a reminder, not an actor (B12). The timer used to
  // replicate manifests, `_meta.json` and the whole snapshot tree — i.e. file
  // contents — into a *second* vendor's cloud on its own; the widest data
  // mover in the codebase, with no gate beyond the setting. Copying now runs
  // only from the notification button. Declining postpones by one interval:
  // the user answered for this occurrence.
  await context.globalState.update(STATE_KEY, Date.now());
  const picked = await vscode.window.showInformationMessage(
    `VSCodeSync: пора сделать резервную копию во второе облако (${secondary}).`,
    "Скопировать",
    "Пропустить",
  );
  if (picked !== "Скопировать") return;

  const primary = await deps.tryAuthenticatedProvider();
  if (!primary) return;
  if (primary.type === secondary) {
    warnLog("backup", `secondaryProvider == primary (${secondary}); skipping`);
    return;
  }

  const target = await getAuthenticatedSecondary(deps.registry, secondary);
  if (!target) {
    warnLog("backup", `secondary provider "${secondary}" is not authenticated`);
    return;
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  let copied = 0;
  for (const folder of folders) {
    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
    for (const aw of wc.activeWorkspaces) {
      try {
        copied += await copyWorkspaceCore(primary, target, aw.workspaceId);
      } catch (e: unknown) {
        warnLog(
          "backup",
          `${aw.workspaceId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  await context.globalState.update(STATE_KEY, Date.now());
  if (copied > 0) {
    verboseLog("backup", `mirrored ${String(copied)} cloud objects to ${secondary}`);
    void vscode.window.showInformationMessage(
      `VSCodeSync: cross-cloud backup → ${secondary} (${String(copied)} объектов).`,
    );
  }
}

/**
 * Copy manifest + `_meta.json` + every snapshot blob for a single workspace.
 * Returns the count of objects mirrored. Skips silently if the primary
 * doesn't have a manifest (orphaned attach). `.history/` recursive copy is
 * intentionally not done here — it's per-file deep, expensive on cloud quota,
 * and the manifest + snapshots are the recovery essentials.
 */
async function copyWorkspaceCore(
  src: ICloudProvider,
  dst: ICloudProvider,
  workspaceId: string,
): Promise<number> {
  let count = 0;

  const tryCopy = async (path: string): Promise<boolean> => {
    try {
      const dl = await src.downloadFile(path);
      await dst.uploadFile(path, dl.body);
      count++;
      return true;
    } catch {
      return false;
    }
  };

  // 1. Manifest (required)
  const ok = await tryCopy(manifestCloudPath(workspaceId));
  if (!ok) return 0;

  // 2. _meta.json (best-effort)
  await tryCopy(metaCloudPath(workspaceId));

  // 3. Snapshots — list `.snapshots/` and recursively copy each entry.
  count += await copySnapshotsTree(src, dst, snapshotsDirForWorkspace(workspaceId));

  // .history/{path}/* — skipped; would require deep recursion across every
  //   tracked file. Not strictly needed for "lost primary" recovery — we
  //   already have the canonical manifest + _meta + snapshots.
  void historyDirForFile;
  void workspaceRootPath;
  void CLOUD_ROOT_DIR;

  return count;
}

/**
 * Recursively mirror everything under `dirPath`. Best-effort: per-entry errors
 * are logged but don't abort. `FileMetadata.size === undefined` is treated as
 * "folder" (provider list APIs don't expose isFolder; size is only set for
 * files in every current provider).
 */
async function copySnapshotsTree(
  src: ICloudProvider,
  dst: ICloudProvider,
  dirPath: string,
): Promise<number> {
  let count = 0;
  let entries: Awaited<ReturnType<ICloudProvider["listFolder"]>>;
  try {
    entries = await src.listFolder(dirPath);
  } catch {
    // .snapshots dir may not exist for fresh workspaces — that's fine.
    return 0;
  }
  for (const entry of entries) {
    if (entry.size === undefined) {
      // Treat as folder; recurse (depth ≤ 3 in practice for snapshot trees).
      count += await copySnapshotsTree(src, dst, entry.cloudPath);
      continue;
    }
    try {
      const dl = await src.downloadFile(entry.cloudPath);
      await dst.uploadFile(entry.cloudPath, dl.body);
      count++;
    } catch (e: unknown) {
      warnLog(
        "backup.snapshots",
        `${entry.cloudPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return count;
}

function isProviderType(s: string): s is ProviderType {
  return s === "onedrive" || s === "gdrive" || s === "yandex" || s === "dropbox";
}

async function getAuthenticatedSecondary(
  registry: ProviderRegistry,
  type: ProviderType,
): Promise<ICloudProvider | null> {
  try {
    const provider = registry.getFor(type);
    if (!provider) return null;
    const ok = await provider.isAuthenticated();
    return ok ? provider : null;
  } catch {
    return null;
  }
}
