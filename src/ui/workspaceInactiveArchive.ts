import * as vscode from "vscode";
import type { WorkspaceConfig } from "../core/types.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { hasArchivedTag, newestTrackedLastSyncMs } from "../utils/workspaceLastActivity.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import {
  findInactiveWorkspaceCandidates,
  inactiveSnoozeKey,
  INACTIVE_SNOOZE_NEVER,
} from "../core/inactiveWorkspaceCandidates.js";
import { readSnoozeMap, setSnoozeEntry } from "../utils/snoozeStore.js";

const SNOOZE_STATE_KEY = "vscodesync.inactiveWorkspaceArchiveSnooze";
const SNOOZE_DAYS = 7;
const DAY_MS = 86_400_000;

/** After startup pull (see sync summary); give cloud + local state time to settle. */
const INACTIVE_SCAN_DELAY_MS = 16_000;




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

  const snooze = readSnoozeMap(deps.extensionContext, SNOOZE_STATE_KEY);
  const folderInputs = [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const wc = await deps.loadWorkspaceConfig(root);
    folderInputs.push({
      folderRootFsPath: root,
      workspaces: wc.activeWorkspaces.map((ent) => ({
        workspaceId: ent.workspaceId,
        workspaceNote: ent.workspaceNote,
        archived: hasArchivedTag(ent.tags),
        active: normalizeWorkspaceSyncState(ent) === "active",
        lastSyncMs: newestTrackedLastSyncMs(wc, ent.workspaceId),
      })),
    });
  }
  // Original behaviour: candidate when inactiveDays > threshold (strict). The
  // pure helper uses inclusive `>=`, so we post-filter the boundary day.
  const candidates = findInactiveWorkspaceCandidates({
    folders: folderInputs,
    minInactiveDays: threshold,
    snoozes: snooze,
  }).filter((c) => c.inactiveDays > threshold);

  for (const c of candidates) {
    const note = c.workspaceNote.trim() || c.workspaceId;
    const picked = await vscode.window.showWarningMessage(
      `VSCodeSync: workspace «${note}» не синхронизировался более ${String(Math.round(threshold))} дн. (≈ ${c.inactiveDays.toFixed(0)} дн.). Архивировать (тег archived + Suspend)?`,
      "Архивировать",
      `Через ${String(SNOOZE_DAYS)} дней`,
      "Не напоминать для этого workspace",
    );
    const sk = inactiveSnoozeKey(c.folderRootFsPath, c.workspaceId);
    if (picked === undefined || picked === `Через ${String(SNOOZE_DAYS)} дней`) {
      const until = new Date(Date.now() + SNOOZE_DAYS * DAY_MS).toISOString();
      await setSnoozeEntry(deps.extensionContext, SNOOZE_STATE_KEY, sk, until);
      continue;
    }
    if (picked === "Не напоминать для этого workspace") {
      await setSnoozeEntry(deps.extensionContext, SNOOZE_STATE_KEY, sk, INACTIVE_SNOOZE_NEVER);
      continue;
    }
    await deps.onArchive({
      folderRootFsPath: c.folderRootFsPath,
      workspaceId: c.workspaceId,
      workspaceNote: c.workspaceNote,
    });
  }
}
