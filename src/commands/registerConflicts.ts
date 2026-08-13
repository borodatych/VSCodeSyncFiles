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
 *
 * `resolveKeepMine` / `resolveTakeTheirs` used to live here as a second,
 * command-layer implementation of the same two actions (C19). They are gone:
 * the first only cleared the conflict flag and told the user to push "if
 * needed" — users picked it over `keepMine` and the file never reached the
 * cloud — and the second persisted `syncStatus = "ok"` to disk *before* the
 * pull, so any pull failure erased the conflict for good (C18).
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
import { isAiMergeAvailable } from "../ui/ai/aiMerge.js";
import { pickRoot } from "./_shared.js";
import { resolveFileTarget } from "./_fileTargetHelpers.js";
import { runAiMergeForConflict, runConflict3WayDiff } from "./_engineFlows.js";
import { keepMineWithCloudMovedPrompt } from "../ui/conflictKeepMinePrompt.js";
import { openVisualMergerPanel } from "../ui/visualMergerPanel.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface ConflictsCommandsDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  runWithEngine: RunWithEngineFn;
  /** Shared instance of the soft-lock / conflict-notification dedupe set —
   * the engine adds keys via `notifyConflict`, palette commands clear them
   * once the user has resolved the file. */
  notifiedConflictKeys: Set<string>;
}

export function registerConflictsCommands(
  deps: ConflictsCommandsDeps,
): vscode.Disposable[] {
  const { context, globalConfig, runWithEngine, notifiedConflictKeys } = deps;
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
        const pushed = await keepMineWithCloudMovedPrompt(
          (opts) => engine.resolveConflictKeepMine(fileEntry.workspaceId, rel, opts),
          rel,
          () => runConflict3WayDiffAt(target),
        );
        if (!pushed) {
          return;
        }
        void vscode.window.showInformationMessage(
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
        void vscode.window.showInformationMessage(
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

    /**
     * Per-hunk conflict resolution. Whole-file "keep mine" / "take theirs"
     * answers the easy cases; this one is for the file where both sides have
     * changes worth keeping. Base is the newest cloud history snapshot —
     * without it there is nothing to three-way against, and the command says
     * so instead of guessing.
     */
    vscode.commands.registerCommand("vscodesync.openVisualMerger", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const posixRel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const localUri = vscode.Uri.file(target.fsPath);
      let localText: string;
      try {
        localText = Buffer.from(await vscode.workspace.fs.readFile(localUri)).toString("utf8");
      } catch {
        void vscode.window.showErrorMessage("VSCodeSync: локальный файл недоступен для чтения.");
        return;
      }
      let cloudText: string | undefined;
      let baseText: string | undefined;
      await runWithEngine(async (engine) => {
        try {
          const { body } = await engine.downloadTrackedBlob(posixRel);
          cloudText = body.toString("utf8");
        } catch { /* no cloud copy — reported below */ }
        try {
          const hist = await engine.listCloudHistoryForTrackedFile(posixRel);
          if (hist.length > 0 && hist[0]) {
            const baseBody = await engine.downloadHistorySnapshotIfOwned(posixRel, hist[0].cloudPath);
            baseText = baseBody.toString("utf8");
          }
        } catch { /* no history — reported below */ }
      }, target.root);

      if (cloudText === undefined) {
        void vscode.window.showWarningMessage(
          "VSCodeSync: облачная версия недоступна — сливать не с чем.",
        );
        return;
      }
      if (baseText === undefined) {
        void vscode.window.showWarningMessage(
          "VSCodeSync: нет снимка истории — общей отправной точки для трёхстороннего слияния не существует. " +
            "Используйте «Оставить моё» / «Взять чужое» или сравнение с облаком.",
        );
        return;
      }
      openVisualMergerPanel(
        context,
        {
          base: baseText.split(/\r?\n/),
          local: localText.split(/\r?\n/),
          cloud: cloudText.split(/\r?\n/),
          label: path.basename(target.fsPath),
          targetUri: localUri,
        },
      );
    }),

    vscode.commands.registerCommand("vscodesync.resolveConflicts", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const conflicts = wc.files.filter((f) => f.syncStatus === "conflict");
      if (conflicts.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: нет конфликтов.");
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
          let done = 0;
          const skipped: string[] = [];
          const failed: string[] = [];
          for (const f of conflicts) {
            try {
              if (batchMode === "keepMineAll") {
                // Batch mode answers for files the user never looked at, so a
                // cloud copy that moved on is left alone instead of buried.
                const r = await engine.resolveConflictKeepMine(f.workspaceId, f.localPath);
                if (r === "cloud_moved") {
                  skipped.push(f.localPath);
                  continue;
                }
              } else {
                await engine.resolveConflictTakeTheirs(f.workspaceId, f.localPath);
              }
              done += 1;
              notifiedConflictKeys.delete(`${f.workspaceId}:${f.localPath}`);
            } catch (e) {
              // An empty catch here used to be followed by an unconditional
              // "resolved N conflicts" — the user was told the batch succeeded
              // while some files were untouched (C19).
              failed.push(`${f.localPath}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          const label = batchMode === "keepMineAll" ? "Keep Mine" : "Take Theirs";
          const parts = [`VSCodeSync: разрешено ${String(done)} из ${String(conflicts.length)} конфликтов (${label}).`];
          if (skipped.length > 0) {
            parts.push(`Пропущено (облако ушло вперёд): ${skipped.join(", ")} — разрешите вручную.`);
          }
          if (failed.length > 0) {
            parts.push(`Не удалось: ${failed.join("; ")}`);
          }
          const text = parts.join(" ");
          if (failed.length > 0) {
            void vscode.window.showWarningMessage(text);
          } else {
            void vscode.window.showInformationMessage(text);
          }
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
          let ok = true;
          await runWithEngine(async (engine) => {
            if (choice === "Keep Mine") {
              const fsPath = path.join(root, ...f.localPath.split("/"));
              ok = await keepMineWithCloudMovedPrompt(
                (opts) => engine.resolveConflictKeepMine(f.workspaceId, f.localPath, opts),
                f.localPath,
                () => runConflict3WayDiffAt({ root, fsPath }),
              );
            } else {
              await engine.resolveConflictTakeTheirs(f.workspaceId, f.localPath);
            }
            if (ok) {
              notifiedConflictKeys.delete(`${f.workspaceId}:${f.localPath}`);
            }
          });
          // Not resolved → the same file comes round again in this loop.
          resolved = ok;
        }
      }
    }),
  ];
}
