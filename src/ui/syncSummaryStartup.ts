import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import type { WorkspaceConfig } from "../core/types.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import {
  buildSyncSummaryDetailText,
  diffTrackedSnapshots,
  formatRuSessionHint,
  type TrackedDiffLine,
} from "./syncSummaryDiff.js";
import { trackedLocalAbsolutePath } from "../core/pathMapping.js";
import { showSyncInfo } from "./notificationService.js";

/** ISO времени последнего завершённого startup-pull (для подписи «с прошлого запуска»). */
export const LAST_ACTIVATION_GLOBAL_KEY = "vscodesync.lastActivationIso";

export type { TrackedDiffLine };

async function openChangedFiles(lines: TrackedDiffLine[], deps: SyncSummaryStartupDeps): Promise<void> {
  const gc = await deps.globalConfig.load();
  const machineName = gc.machineName;
  const cfgCache = new Map<string, WorkspaceConfig>();
  const seen = new Set<string>();
  for (const ln of lines) {
    let wc = cfgCache.get(ln.folderRootFsPath);
    if (!wc) {
      wc = await deps.loadWorkspaceConfig(ln.folderRootFsPath);
      cfgCache.set(ln.folderRootFsPath, wc);
    }
    let abs: string;
    try {
      abs = trackedLocalAbsolutePath(ln.folderRootFsPath, wc.pathMapping, machineName, ln.localPath);
    } catch {
      continue;
    }
    if (seen.has(abs)) {
      continue;
    }
    seen.add(abs);
    try {
      await fs.access(abs);
    } catch {
      continue;
    }
    const uri = vscode.Uri.file(abs);
    try {
      await vscode.window.showTextDocument(uri);
    } catch {
      /* ignore */
    }
  }
}

async function showSummaryModal(lines: TrackedDiffLine[], prevIso: string | undefined, deps: SyncSummaryStartupDeps): Promise<void> {
  const hint = formatRuSessionHint(prevIso, vscode.env.language);
  const detail = buildSyncSummaryDetailText(lines, hint);
  // Skip summary modal when user wants minimal notifications
  const picked = await showSyncInfo(
    `☁ VSCodeSync — изменения после pull (${String(lines.length)})`,
    "normal",
    "Открыть изменённые файлы",
    "Закрыть",
  );
  if (picked === "Открыть изменённые файлы") {
    await openChangedFiles(lines, deps);
  }
  void detail; // kept for future verbose/output panel use
}

export interface SyncSummaryStartupDeps {
  startupChannel: vscode.OutputChannel;
  globalConfig: GlobalConfigManager;
  getConfiguration: () => vscode.WorkspaceConfiguration;
  workspaceFolders: () => readonly vscode.WorkspaceFolder[];
  loadWorkspaceConfig: (folderRootFsPath: string) => Promise<WorkspaceConfig>;
  pullAllQuiet: (folderRootFsPath: string) => Promise<void>;
  /** When startup automatic pull should be skipped (outside sync schedule), enqueue deferred sync and return true. */
  deferAutomaticStartupPull?: () => Promise<boolean>;
}

async function runCycle(context: vscode.ExtensionContext, deps: SyncSummaryStartupDeps): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    deps.startupChannel.appendLine("Sync Summary: пропуск — workspace не доверен.");
    return;
  }
  const conf = deps.getConfiguration();
  if (!conf.get<boolean>("syncSummaryOnStartup", true)) {
    return;
  }
  const gc = await deps.globalConfig.load();
  if (!gc.onboardingCompleted) {
    return;
  }

  if (deps.deferAutomaticStartupPull) {
    const defer = await deps.deferAutomaticStartupPull();
    if (defer) {
      return;
    }
  }

  const folders = deps.workspaceFolders();
  if (folders.length === 0) {
    return;
  }

  const prevIso = context.globalState.get<string>(LAST_ACTIVATION_GLOBAL_KEY);

  const snap = new Map<string, WorkspaceConfig>();
  for (const f of folders) {
    snap.set(f.uri.fsPath, await deps.loadWorkspaceConfig(f.uri.fsPath));
  }

  let attemptedPull = false;
  for (const f of folders) {
    const cfg = snap.get(f.uri.fsPath);
    if (!cfg || cfg.activeWorkspaces.length === 0) {
      continue;
    }
    attemptedPull = true;
    await deps.pullAllQuiet(f.uri.fsPath);
  }

  if (!attemptedPull) {
    return;
  }

  const nowIso = new Date().toISOString();
  await context.globalState.update(LAST_ACTIVATION_GLOBAL_KEY, nowIso);

  const all: TrackedDiffLine[] = [];
  for (const f of folders) {
    const before = snap.get(f.uri.fsPath);
    const after = await deps.loadWorkspaceConfig(f.uri.fsPath);
    if (!before) {
      continue;
    }
    all.push(...diffTrackedSnapshots(before, after, f.uri.fsPath));
  }

  if (all.length === 0) {
    return;
  }

  await showSummaryModal(all, prevIso, deps);
}

/**
 * Отложенный startup pull + сводка изменений (если включено и есть отличия).
 */
export function scheduleStartupSyncSummary(context: vscode.ExtensionContext, deps: SyncSummaryStartupDeps): void {
  const DELAY_MS = 4000;
  const handle = setTimeout(() => {
    void runCycle(context, deps).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      deps.startupChannel.appendLine(`Sync Summary startup: ${msg}`);
    });
  }, DELAY_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(handle);
    }),
  );
}
