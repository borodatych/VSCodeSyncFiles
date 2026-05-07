import * as vscode from "vscode";
import type { WorkspaceConfig } from "../core/types.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { hasArchivedTag, newestTrackedLastSyncMs } from "../utils/workspaceLastActivity.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";

const SNOOZE_STATE_KEY = "vscodesync.inactiveWorkspaceArchiveSnooze";
const SNOOZE_DAYS = 7;
const NEVER_REMIND = "__never";
const DAY_MS = 86_400_000;

/** After startup pull (see sync summary); give cloud + local state time to settle. */
const INACTIVE_SCAN_DELAY_MS = 16_000;

function snoozeMap(ctx: vscode.ExtensionContext): Record<string, string> {
  return ctx.globalState.get<Record<string, string>>(SNOOZE_STATE_KEY) ?? {};
}

async function updateSnooze(
  ctx: vscode.ExtensionContext,
  key: string,
  value: string | undefined,
): Promise<void> {
  const prev = snoozeMap(ctx);
  const next =
    value === undefined
      ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key))
      : { ...prev, [key]: value };
  await ctx.globalState.update(SNOOZE_STATE_KEY, next);
}

function snoozeKey(folderRootFsPath: string, workspaceId: string): string {
  return `${folderRootFsPath}\u0000${workspaceId}`;
}

function isSnoozeActive(map: Record<string, string>, key: string): boolean {
  const v = map[key];
  if (v === NEVER_REMIND) {
    return true;
  }
  if (!v) {
    return false;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) && Date.now() < t;
}

export interface WorkspaceInactiveArchiveDeps {
  startupChannel: vscode.OutputChannel;
  globalConfig: GlobalConfigManager;
  getConfiguration: () => vscode.WorkspaceConfiguration;
  workspaceFolders: () => readonly vscode.WorkspaceFolder[];
  loadWorkspaceConfig: (folderRootFsPath: string) => Promise<WorkspaceConfig>;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  extensionContext: vscode.ExtensionContext;
  /** User accepted «Архивировать» — cloud + локальное состояние. */
  onArchive: (args: {
    folderRootFsPath: string;
    workspaceId: string;
    workspaceNote: string;
  }) => Promise<void>;
}

interface Candidate {
  folderRootFsPath: string;
  workspaceId: string;
  workspaceNote: string;
  inactiveDays: number;
}

export function scheduleWorkspaceInactiveArchivePrompt(context: vscode.ExtensionContext, deps: WorkspaceInactiveArchiveDeps): void {
  const handle = setTimeout(() => {
    void runInactiveScan(context, deps).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      deps.startupChannel.appendLine(`Workspace inactive archive: ${msg}`);
    });
  }, INACTIVE_SCAN_DELAY_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(handle);
    }),
  );
}

async function runInactiveScan(_context: vscode.ExtensionContext, deps: WorkspaceInactiveArchiveDeps): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }
  const gc = await deps.globalConfig.load();
  if (!gc.onboardingCompleted) {
    return;
  }
  const conf = deps.getConfiguration();
  const threshold = conf.get<number>("workspaceInactiveDays", 90);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return;
  }
  if (!(await deps.tryAuthenticatedProvider())) {
    return;
  }

  const folders = deps.workspaceFolders();
  if (folders.length === 0) {
    return;
  }

  const candidates: Candidate[] = [];
  const snooze = snoozeMap(deps.extensionContext);

  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const wc = await deps.loadWorkspaceConfig(root);
    for (const ent of wc.activeWorkspaces) {
      if (hasArchivedTag(ent.tags)) {
        continue;
      }
      const st = normalizeWorkspaceSyncState(ent);
      if (st !== "active") {
        continue;
      }
      const newest = newestTrackedLastSyncMs(wc, ent.workspaceId);
      if (newest === undefined) {
        continue;
      }
      const inactiveDays = (Date.now() - newest) / DAY_MS;
      if (inactiveDays <= threshold) {
        continue;
      }
      const sk = snoozeKey(root, ent.workspaceId);
      if (isSnoozeActive(snooze, sk)) {
        continue;
      }
      candidates.push({
        folderRootFsPath: root,
        workspaceId: ent.workspaceId,
        workspaceNote: ent.workspaceNote,
        inactiveDays,
      });
    }
  }

  candidates.sort((a, b) => b.inactiveDays - a.inactiveDays);

  for (const c of candidates) {
    const note = c.workspaceNote.trim() || c.workspaceId;
    const picked = await vscode.window.showWarningMessage(
      `VSCodeSync: workspace «${note}» не синхронизировался более ${String(Math.round(threshold))} дн. (≈ ${c.inactiveDays.toFixed(0)} дн.). Архивировать (тег archived + Suspend)?`,
      "Архивировать",
      `Через ${String(SNOOZE_DAYS)} дней`,
      "Не напоминать для этого workspace",
    );
    const sk = snoozeKey(c.folderRootFsPath, c.workspaceId);
    if (picked === undefined || picked === `Через ${String(SNOOZE_DAYS)} дней`) {
      const until = new Date(Date.now() + SNOOZE_DAYS * DAY_MS).toISOString();
      await updateSnooze(deps.extensionContext, sk, until);
      continue;
    }
    if (picked === "Не напоминать для этого workspace") {
      await updateSnooze(deps.extensionContext, sk, NEVER_REMIND);
      continue;
    }
    await deps.onArchive({
      folderRootFsPath: c.folderRootFsPath,
      workspaceId: c.workspaceId,
      workspaceNote: c.workspaceNote,
    });
  }
}
