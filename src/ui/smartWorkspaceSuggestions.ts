import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { WorkspaceConfig } from "../core/types.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { loadActivityFile } from "../core/activityLog.js";
import {
  SMART_SUGGESTIONS_ARCHIVE_DAYS,
  analyzeCoEditClusters,
  clusterAlreadySingleLocalWorkspace,
  clusterHasMultipleWorkspaceIdsInActivity,
  coEditClusterFingerprint,
  COEDIT_WINDOW_MS,
} from "../core/smartSuggestionsModel.js";
import { hasArchivedTag, newestTrackedLastSyncMs } from "../utils/workspaceLastActivity.js";
import {
  findInactiveWorkspaceCandidates,
  inactiveSnoozeKey,
  isInactiveSnoozeActive,
  INACTIVE_SNOOZE_NEVER,
} from "../core/inactiveWorkspaceCandidates.js";
import { readSnoozeMap, setSnoozeEntry } from "../utils/snoozeStore.js";

/** After other startup tasks (sync summary, inactive scan). */
const STARTUP_DELAY_MS = 22_000;

const LAST_RUN_DAY_KEY = "vscodesync.smartSuggestions.lastRunDay";
const DISMISSED_COEDIT_KEY = "vscodesync.smartSuggestions.dismissedCoeditForever";
const COEDIT_SNOOZE_KEY = "vscodesync.smartSuggestions.coeditSnoozeUntil";
const EARLY_ARCHIVE_SNOOZE_KEY = "vscodesync.smartSuggestions.earlyArchive60Snooze";

const SNOOZE_DAYS = 7;
const DAY_MS = 86_400_000;

function todayLocalKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(y)}-${m}-${day}`;
}





/** Minimal provider check for smart suggestions (archive path). */
export interface ICloudProviderLike {
  type?: string;
}

export interface SmartWorkspaceSuggestionsDeps {
  globalConfig: GlobalConfigManager;
  getConfiguration: () => vscode.WorkspaceConfiguration;
  workspaceFolders: () => readonly vscode.WorkspaceFolder[];
  loadWorkspaceConfig: (folderRootFsPath: string) => Promise<WorkspaceConfig>;
  tryAuthenticatedProvider: () => Promise<ICloudProviderLike | null>;
  startupChannel: vscode.OutputChannel;
  onCreateWorkspaceWithFiles: (args: {
    folderRoot: string;
    note: string;
    absolutePaths: string[];
  }) => Promise<void>;
  onEarlyArchive: (args: {
    folderRootFsPath: string;
    workspaceId: string;
    workspaceNote: string;
  }) => Promise<void>;
}

export function scheduleSmartWorkspaceSuggestions(context: vscode.ExtensionContext, deps: SmartWorkspaceSuggestionsDeps): void {
  const handle = setTimeout(() => {
    void runSmartSuggestions(context, deps).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      deps.startupChannel.appendLine(`Smart suggestions: ${msg}`);
    });
  }, STARTUP_DELAY_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(handle);
    }),
  );
}

async function runSmartSuggestions(context: vscode.ExtensionContext, deps: SmartWorkspaceSuggestionsDeps): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }
  const conf = deps.getConfiguration();
  if (!conf.get<boolean>("smartSuggestions", true)) {
    return;
  }
  const gc = await deps.globalConfig.load();
  if (!gc.onboardingCompleted) {
    return;
  }

  const folders = deps.workspaceFolders();
  if (folders.length === 0) {
    return;
  }

  const day = todayLocalKey();
  const last = context.globalState.get<string>(LAST_RUN_DAY_KEY);
  if (last === day) {
    return;
  }
  await context.globalState.update(LAST_RUN_DAY_KEY, day);

  const file = await loadActivityFile(deps.globalConfig.getStorageDir());
  const configs: { root: string; wc: WorkspaceConfig }[] = [];
  for (const f of folders) {
    configs.push({ root: f.uri.fsPath, wc: await deps.loadWorkspaceConfig(f.uri.fsPath) });
  }

  let showedCoEdit = false;
  const clusters = analyzeCoEditClusters(file.events, Date.now());
  const dismissed = new Set(context.globalState.get<string[]>(DISMISSED_COEDIT_KEY) ?? []);
  const coSnooze = readSnoozeMap(context, COEDIT_SNOOZE_KEY);

  for (const c of clusters) {
    if (c.paths.length > 12) {
      continue;
    }
    if (!clusterHasMultipleWorkspaceIdsInActivity(c.paths, file.events, Date.now(), COEDIT_WINDOW_MS)) {
      continue;
    }
    if (clusterAlreadySingleLocalWorkspace(c.paths, configs)) {
      continue;
    }
    const fp = coEditClusterFingerprint(c.paths);
    if (dismissed.has(fp) || isInactiveSnoozeActive(coSnooze[fp], Date.now())) {
      continue;
    }

    const detail = `${c.paths.join("  •  ")}\n\nПо журналу activity за ~2 нед.: такие пути синхронизировались в один день из разных workspace не реже ${String(c.score)} раз.`;
    const picked = await vscode.window.showInformationMessage(
      "💡 VSCodeSync: часто синхронизируемые вместе файлы из разных workspace",
      { modal: false, detail },
      "Создать",
      "Игнорировать",
      "Не спрашивать снова",
    );
    showedCoEdit = true;
    if (picked === "Не спрашивать снова") {
      dismissed.add(fp);
      await context.globalState.update(DISMISSED_COEDIT_KEY, [...dismissed]);
    } else if (picked === "Игнорировать") {
      const until = new Date(Date.now() + SNOOZE_DAYS * DAY_MS).toISOString();
      await setSnoozeEntry(context, COEDIT_SNOOZE_KEY, fp, until);
    } else if (picked === "Создать") {
      const note =
        (await vscode.window.showInputBox({
          title: "VSCodeSync: новый workspace",
          value: "Связанные файлы (подсказка)",
          placeHolder: "Название workspace",
        })) ?? "";
      if (!note.trim()) {
        return;
      }
      const absResolved = await pickBestFolderForPaths(folders, c.paths);
      if (!absResolved) {
        await vscode.window.showWarningMessage("VSCodeSync: файлы из подсказки не найдены под корнями workspace.");
        return;
      }
      try {
        await deps.onCreateWorkspaceWithFiles({
          folderRoot: absResolved.root,
          note: note.trim(),
          absolutePaths: absResolved.abs,
        });
        void vscode.window.showInformationMessage("VSCodeSync: workspace создан, файлы добавлены в трекинг.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`VSCodeSync: ${msg}`);
      }
    }
    break;
  }

  if (showedCoEdit) {
    return;
  }

  const inactiveThreshold = conf.get<number>("workspaceInactiveDays", 90);
  if (!Number.isFinite(inactiveThreshold) || inactiveThreshold <= SMART_SUGGESTIONS_ARCHIVE_DAYS) {
    return;
  }
  if (!(await deps.tryAuthenticatedProvider())) {
    return;
  }

  const earlySnooze = readSnoozeMap(context, EARLY_ARCHIVE_SNOOZE_KEY);

  const earlyFolderInputs = configs.map(({ root, wc }) => ({
    folderRootFsPath: root,
    workspaces: wc.activeWorkspaces.map((ent) => ({
      workspaceId: ent.workspaceId,
      workspaceNote: ent.workspaceNote,
      archived: hasArchivedTag(ent.tags),
      active: normalizeWorkspaceSyncState(ent) === "active",
      lastSyncMs: newestTrackedLastSyncMs(wc, ent.workspaceId),
    })),
  }));
  const earlyCandidates = findInactiveWorkspaceCandidates({
    folders: earlyFolderInputs,
    minInactiveDays: SMART_SUGGESTIONS_ARCHIVE_DAYS,
    maxInactiveDays: inactiveThreshold,
    snoozes: earlySnooze,
  });
  for (const c of earlyCandidates) {
    const sk = inactiveSnoozeKey(c.folderRootFsPath, c.workspaceId);
    const note = c.workspaceNote.trim() || c.workspaceId;
    const picked = await vscode.window.showInformationMessage(
      `VSCodeSync: workspace «${note}» не использовался около ${String(Math.round(c.inactiveDays))} дн. (более 2 месяцев без синхронизации отслеживаемых файлов). Архивировать?`,
      "Архивировать",
      `Через ${String(SNOOZE_DAYS)} дней`,
      "Не напоминать для этого workspace",
    );
    if (picked === undefined || picked === `Через ${String(SNOOZE_DAYS)} дней`) {
      const until = new Date(Date.now() + SNOOZE_DAYS * DAY_MS).toISOString();
      await setSnoozeEntry(context, EARLY_ARCHIVE_SNOOZE_KEY, sk, until);
      continue;
    }
    if (picked === "Не напоминать для этого workspace") {
      await setSnoozeEntry(context, EARLY_ARCHIVE_SNOOZE_KEY, sk, INACTIVE_SNOOZE_NEVER);
      continue;
    }
    await deps.onEarlyArchive({
      folderRootFsPath: c.folderRootFsPath,
      workspaceId: c.workspaceId,
      workspaceNote: c.workspaceNote,
    });
    break;
  }
}

async function pickBestFolderForPaths(
  folders: readonly vscode.WorkspaceFolder[],
  relPaths: string[],
): Promise<{ root: string; abs: string[] } | undefined> {
  let best: { root: string; abs: string[]; score: number } | undefined;
  for (const folder of folders) {
    const absList: string[] = [];
    for (const rel of relPaths) {
      const abs = path.join(folder.uri.fsPath, ...normRelSegments(rel));
      try {
        await fs.access(abs);
        absList.push(abs);
      } catch {
        /* try next root */
      }
    }
    if (absList.length > 0 && (best === undefined || absList.length > best.score)) {
      best = { root: folder.uri.fsPath, abs: absList, score: absList.length };
    }
  }
  if (!best) {
    return undefined;
  }
  return { root: best.root, abs: best.abs };
}

function normRelSegments(rel: string): string[] {
  return rel.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
}
