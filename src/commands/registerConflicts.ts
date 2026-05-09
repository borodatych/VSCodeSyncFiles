/**
 * Conflict-resolution palette command bundle — ninth tranche of the
 * `extension.ts` decomposition (v2.6 in the roadmap).
 *
 * Holds the 8 commands users invoke from the palette / inline-CodeLens
 * to resolve file conflicts:
 *   - keepMine / takeTheirs (engine-side merge, soft-lock cleanup)
 *   - keepMineWithRange / takeTheirsWithRange (CodeLens variants that
 *     record the conflict block range to the heatmap before delegating)
 *   - openConflictDiff3way (3-way diff view)
 *   - resolveTakeTheirs (palette: pull cloud version, log activity)
 *   - resolveKeepMine (palette: clear conflict flag locally)
 *   - resolveConflicts (one-by-one queue UI with bulk + AI-merge options)
 *
 * Same contract as the prior bundles. Heavier deps surface because this
 * is the conflict-resolution surface — it needs the engine, the activity
 * log, and the AI-merge / 3-way-diff UI helpers.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ActivityEventInput } from "../core/activityLog.js";
import { isAiMergeAvailable } from "../core/aiMerge.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import { pickRoot } from "./_shared.js";
import { resolveFileTarget } from "./_fileTargetHelpers.js";
import { runAiMergeForConflict, runConflict3WayDiff } from "./_engineFlows.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface ConflictsCommandsDeps {
  globalConfig: GlobalConfigManager;
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
  fileDecorations: SyncFileDecorationController;
  refreshActiveEditor: () => void;
  runWithEngine: RunWithEngineFn;
  logSyncActivity: (ev: ActivityEventInput) => void;
  /** Shared instance of the soft-lock / conflict-notification dedupe set —
   * the engine adds keys via `notifyConflict`, palette commands clear them
   * once the user has resolved the file. */
  notifiedConflictKeys: Set<string>;
}

export function registerConflictsCommands(
  deps: ConflictsCommandsDeps,
): vscode.Disposable[] {
  const {
    globalConfig,
    workspacesTree,
    statusBar,
    fileDecorations,
    refreshActiveEditor,
    runWithEngine,
    logSyncActivity,
    notifiedConflictKeys,
  } = deps;
  const runConflict3WayDiffAt = (target: { root: string; fsPath: string }): Promise<void> =>
    runConflict3WayDiff(runWithEngine, target);
  const runAiMergeForConflictAt = (
    target: { root: string; fsPath: string },
    workspaceId: string,
    localPath: string,
  ): Promise<boolean> => runAiMergeForConflict(runWithEngine, target, workspaceId, localPath, notifiedConflictKeys);

  async function recordHeatmapRangeForUri(
    uri: vscode.Uri | undefined,
    range: { startLine: number; endLine: number } | undefined,
  ): Promise<void> {
    if (!uri || !range) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) return;
    try {
      const { recordConflictResolution } = await import("../ui/conflictHeatmapStoreFs.js");
      await recordConflictResolution(globalConfig.getStorageDir(), rel, range.startLine, range.endLine);
    } catch {
      /* heatmap is best-effort; silent on I/O errors */
    }
  }

  return [
    vscode.commands.registerCommand("vscodesync.keepMine", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg = await WorkspaceConfigManager.load(target.root);
      const fileEntry = cfg.files.find((f) => f.localPath === rel && f.syncStatus === "conflict");
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не находится в состоянии конфликта.");
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.resolveConflictKeepMine(fileEntry.workspaceId, rel);
        await vscode.window.showInformationMessage(
          `Конфликт разрешён: оставлена локальная версия «${path.basename(target.fsPath)}».`,
        );
        notifiedConflictKeys.delete(`${fileEntry.workspaceId}:${rel}`);
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.takeTheirs", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg = await WorkspaceConfigManager.load(target.root);
      const fileEntry = cfg.files.find((f) => f.localPath === rel && f.syncStatus === "conflict");
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не находится в состоянии конфликта.");
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.resolveConflictTakeTheirs(fileEntry.workspaceId, rel);
        await vscode.window.showInformationMessage(
          `Конфликт разрешён: принята облачная версия «${path.basename(target.fsPath)}».`,
        );
        notifiedConflictKeys.delete(`${fileEntry.workspaceId}:${rel}`);
      }, target.root);
    }),

    // Inline-CodeLens variants — same effect, but record the conflict's real
    // line range in the heatmap before delegating.
    vscode.commands.registerCommand(
      "vscodesync.keepMineWithRange",
      async (uri: vscode.Uri | undefined, range: { startLine: number; endLine: number } | undefined) => {
        await recordHeatmapRangeForUri(uri, range);
        await vscode.commands.executeCommand("vscodesync.keepMine", uri);
      },
    ),
    vscode.commands.registerCommand(
      "vscodesync.takeTheirsWithRange",
      async (uri: vscode.Uri | undefined, range: { startLine: number; endLine: number } | undefined) => {
        await recordHeatmapRangeForUri(uri, range);
        await vscode.commands.executeCommand("vscodesync.takeTheirs", uri);
      },
    ),

    vscode.commands.registerCommand("vscodesync.openConflictDiff3way", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      await runConflict3WayDiffAt(target);
    }),

    vscode.commands.registerCommand("vscodesync.resolveTakeTheirs", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      await runWithEngine(async (engine, root) => {
        let cfg = await WorkspaceConfigManager.load(root);
        const row = cfg.files.find((f) => f.localPath === rel);
        if (row?.syncStatus !== "conflict") {
          await vscode.window.showWarningMessage("VSCodeSync: нет конфликта для этого файла.");
          return;
        }
        row.syncStatus = "ok";
        await WorkspaceConfigManager.save(cfg, root);
        cfg = await WorkspaceConfigManager.load(root);
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === row.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден.");
          return;
        }
        await engine.pullFile(cfg, row.workspaceId, rel, entry);
        const gconf = await globalConfig.load();
        const wnote =
          cfg.activeWorkspaces.find((w) => w.workspaceId === row.workspaceId)?.workspaceNote ?? row.workspaceId;
        logSyncActivity({
          kind: "resolve_take_theirs",
          workspaceId: row.workspaceId,
          workspaceNote: wnote,
          relPath: rel,
          machineName: gconf.machineName,
          provider: gconf.activeProvider ?? "onedrive",
        });
        await vscode.window.showInformationMessage(`Принята облачная версия: ${rel}`);
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.resolveKeepMine", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const cfg = await WorkspaceConfigManager.load(target.root);
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      let touched = false;
      for (const f of cfg.files) {
        if (f.localPath === rel) {
          f.syncStatus = "ok";
          touched = true;
        }
      }
      if (!touched) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
        return;
      }
      await WorkspaceConfigManager.save(cfg, target.root);
      await vscode.window.showInformationMessage("Флаг конфликта снят; при необходимости выполните Push.");
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
    }),

    vscode.commands.registerCommand("vscodesync.resolveConflicts", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const conflicts = wc.files.filter((f) => f.syncStatus === "conflict");
      if (conflicts.length === 0) {
        await vscode.window.showInformationMessage("VSCodeSync: нет конфликтов.");
        return;
      }

      type BatchChoice = "keepMineAll" | "taketheirsAll" | "manual";

      let batchMode: BatchChoice = "manual";
      if (conflicts.length > 1) {
        const bulk = await vscode.window.showWarningMessage(
          `VSCodeSync: ${String(conflicts.length)} файлов в конфликте. Как разрешить?`,
          "Keep Mine All",
          "Take Theirs All",
          "Разрешить по одному",
        );
        if (!bulk) {
          return;
        }
        if (bulk === "Keep Mine All") {
          batchMode = "keepMineAll";
        } else if (bulk === "Take Theirs All") {
          batchMode = "taketheirsAll";
        }
      }

      if (batchMode !== "manual") {
        await runWithEngine(async (engine) => {
          for (const f of conflicts) {
            try {
              if (batchMode === "keepMineAll") {
                await engine.resolveConflictKeepMine(f.workspaceId, f.localPath);
              } else {
                await engine.resolveConflictTakeTheirs(f.workspaceId, f.localPath);
              }
              notifiedConflictKeys.delete(`${f.workspaceId}:${f.localPath}`);
            } catch {
              /* individual errors are non-fatal in batch */
            }
          }
          await vscode.window.showInformationMessage(
            `VSCodeSync: разрешено ${String(conflicts.length)} конфликтов (${batchMode === "keepMineAll" ? "Keep Mine" : "Take Theirs"}).`,
          );
        });
        return;
      }

      const aiAvailable = await isAiMergeAvailable();
      for (const f of conflicts) {
        let resolved = false;
        while (!resolved) {
          const idx = conflicts.indexOf(f);
          const wsNote = wc.activeWorkspaces.find((w) => w.workspaceId === f.workspaceId)?.workspaceNote ?? f.workspaceId;
          const buttons = aiAvailable
            ? ["Keep Mine", "Take Theirs", "Open Diff", "✨ Merge with AI", "Skip"]
            : ["Keep Mine", "Take Theirs", "Open Diff", "Skip"];
          const choice = await vscode.window.showWarningMessage(
            `⚠ Конфликт ${String(idx + 1)}/${String(conflicts.length)}: ${f.localPath} (workspace «${wsNote}»)`,
            ...buttons,
          );
          if (!choice || choice === "Skip") {
            resolved = true;
            continue;
          }
          if (choice === "Open Diff") {
            const conflictUri = vscode.Uri.file(path.join(root, ...f.localPath.split("/")));
            await runConflict3WayDiffAt({ root, fsPath: conflictUri.fsPath });
            continue;
          }
          if (choice === "✨ Merge with AI") {
            const conflictUri = vscode.Uri.file(path.join(root, ...f.localPath.split("/")));
            const aiResolved = await runAiMergeForConflictAt(
              { root, fsPath: conflictUri.fsPath },
              f.workspaceId,
              f.localPath,
            );
            if (aiResolved) {
              resolved = true;
            }
            continue;
          }
          await runWithEngine(async (engine) => {
            if (choice === "Keep Mine") {
              await engine.resolveConflictKeepMine(f.workspaceId, f.localPath);
            } else {
              await engine.resolveConflictTakeTheirs(f.workspaceId, f.localPath);
            }
            notifiedConflictKeys.delete(`${f.workspaceId}:${f.localPath}`);
          });
          resolved = true;
        }
      }
    }),
  ];
}
