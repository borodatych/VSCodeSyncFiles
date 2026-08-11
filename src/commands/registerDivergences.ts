/**
 * `vscodesync.openDivergences` and the actions the panel routes to (stage 3.5).
 *
 * The panel owns presentation; this module owns the two things it must not:
 * loading state from every open root, and executing what the user picked. Both
 * halves go through the ordinary engine methods, so the mutation checkpoint
 * sees them as the user-triggered operations they are.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { trackedAbsolutePathFor } from "../core/trackedPathResolver.js";
import { warnLog } from "../utils/log.js";
import {
  buildDivergencePlan,
  describeDivergenceCounts,
  summariseDivergences,
  type DivergenceGroup,
  type DivergenceRow,
} from "../core/divergencePlan.js";
import { openDivergencePanel, updateDivergencePanel } from "../ui/divergencePanel.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";
import { keepMineWithCloudMovedPrompt } from "../ui/conflictKeepMinePrompt.js";
import { chooseMissingFilePlacement } from "./_placementFlow.js";

export interface DivergencesCommandsDeps {
  runWithEngine: RunWithEngineFn;
  workspaceFolders: () => readonly vscode.WorkspaceFolder[];
  refreshUi: () => void | Promise<void>;
}

/** Rows grouped per root, so each engine run stays inside one workspace root. */
function groupRowsByRoot(rows: readonly DivergenceRow[]): Map<string, DivergenceRow[]> {
  const byRoot = new Map<string, DivergenceRow[]>();
  for (const r of rows) {
    const list = byRoot.get(r.root);
    if (list) list.push(r);
    else byRoot.set(r.root, [r]);
  }
  return byRoot;
}

/**
 * Read the plan from what the detector already recorded.
 *
 * `recount` runs a detector pass first — that is the "Обновить" button. It is
 * the only cloud traffic the panel causes, and it is `checkWorkspaceStatus`,
 * which writes statuses and nothing else.
 */
async function loadPlan(
  deps: DivergencesCommandsDeps,
  recount: boolean,
): Promise<DivergenceGroup[]> {
  const roots = deps.workspaceFolders().map((f) => f.uri.fsPath);
  if (recount) {
    for (const root of roots) {
      const cfg = await WorkspaceConfigManager.load(root);
      if (cfg.activeWorkspaces.length === 0) continue;
      await deps.runWithEngine(
        async (engine) => {
          for (const aw of cfg.activeWorkspaces) {
            try {
              await engine.checkWorkspaceStatus(aw.workspaceId);
            } catch (e) {
              // One unreachable workspace must not blank the whole panel.
              warnLog("divergences", `recount ${aw.workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        },
        root,
        { showErrorDialog: false, trigger: "user" },
      );
    }
  }
  const inputs = [];
  for (const root of roots) {
    inputs.push({ root, cfg: await WorkspaceConfigManager.load(root) });
  }
  return buildDivergencePlan(inputs);
}

async function runBulk(
  deps: DivergencesCommandsDeps,
  direction: "push" | "pull",
  rows: readonly DivergenceRow[],
): Promise<string> {
  const verb = direction === "push" ? "Отправка" : "Скачивание";
  let done = 0;
  const failed: string[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `VSCodeSync · ${verb}`, cancellable: false },
    async (progress) => {
      for (const [root, rootRows] of groupRowsByRoot(rows)) {
        await deps.runWithEngine(
          async (engine) => {
            for (const row of rootRows) {
              progress.report({
                message: `${row.posixRel} (${String(done + 1)}/${String(rows.length)})`,
                increment: 100 / rows.length,
              });
              // Reloaded per file: push/pull mutate the config, and a stale
              // copy would overwrite the previous file's recorded status.
              const cfg = await WorkspaceConfigManager.load(root);
              const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === row.workspaceId);
              if (!entry) {
                failed.push(`${row.posixRel}: воркспейс не подключён`);
                continue;
              }
              try {
                if (direction === "push") {
                  await engine.pushFile(cfg, row.workspaceId, row.posixRel, entry);
                } else {
                  await engine.pullFile(cfg, row.workspaceId, row.posixRel, entry);
                }
                await WorkspaceConfigManager.save(cfg, root);
                done += 1;
              } catch (e) {
                // Per-file isolation: one refusal must not abandon the rest of
                // what the user ticked.
                const msg = e instanceof Error ? e.message : String(e);
                failed.push(`${row.posixRel}: ${msg}`);
                warnLog("divergences", `${direction} ${row.posixRel}: ${msg}`);
              }
            }
          },
          root,
          { showErrorDialog: false, trigger: "user" },
        );
      }
    },
  );

  await deps.refreshUi();
  const head = `VSCodeSync: ${direction === "push" ? "отправлено" : "скачано"} ${String(done)} из ${String(rows.length)}.`;
  if (failed.length === 0) return head;
  return `${head} Не удалось: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? ` … +${String(failed.length - 3)}` : ""}`;
}

async function openCompare(row: DivergenceRow): Promise<void> {
  const abs = await trackedAbsolutePathFor(row.root, row.posixRel);
  if (abs === undefined) {
    void vscode.window.showWarningMessage(`VSCodeSync: не удалось определить путь «${row.posixRel}».`);
    return;
  }
  const uri = vscode.Uri.file(abs);
  // Conflicts get the three-way view; everything else the plain cloud diff.
  await vscode.commands.executeCommand(
    row.direction === "conflict" ? "vscodesync.openConflictDiff3way" : "vscodesync.diffWithCloud",
    uri,
  );
}

async function resolveConflict(deps: DivergencesCommandsDeps, row: DivergenceRow): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "Оставить моё", detail: "Локальная версия отправляется в облако", id: "mine" },
      { label: "Взять их версию", detail: "Облачная версия перезаписывает локальную", id: "theirs" },
      { label: "Сохранить обе", detail: "Облачная версия ляжет рядом отдельным файлом", id: "both" },
      { label: "Открыть 3-way сравнение", detail: "Решить позже, сначала посмотреть", id: "diff" },
    ],
    { title: `Конфликт: ${row.posixRel}`, placeHolder: "Что сделать с файлом?" },
  );
  if (!picked) return;
  if (picked.id === "diff") {
    await openCompare(row);
    return;
  }
  await deps.runWithEngine(
    async (engine) => {
      if (picked.id === "mine") {
        await keepMineWithCloudMovedPrompt(
          (opts) => engine.resolveConflictKeepMine(row.workspaceId, row.posixRel, opts),
          row.posixRel,
          () => openCompare(row),
        );
      } else if (picked.id === "theirs") {
        await engine.resolveConflictTakeTheirs(row.workspaceId, row.posixRel);
      } else {
        await engine.resolveConflictKeepBoth(row.workspaceId, row.posixRel);
      }
    },
    row.root,
    { trigger: "user" },
  );
  await deps.refreshUi();
}

export function registerDivergencesCommands(deps: DivergencesCommandsDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vscodesync.openDivergences", () => {
      openDivergencePanel({
        refresh: () => loadPlan(deps, true),
        bulk: (direction, rows) => runBulk(deps, direction, rows),
        compare: (row) => openCompare(row),
        resolve: (row) => resolveConflict(deps, row),
        // Link Bindings (stage 2): «Привязать…» on rows absent from disk —
        // same placement chooser as the tree pull; a "pull" outcome downloads
        // into the chosen spot right away.
        bind: async (row) => {
          const outcome = await chooseMissingFilePlacement(
            deps.runWithEngine,
            vscode.Uri.file(row.root),
            row.workspaceId,
            row.posixRel,
            row.manifestPath ?? row.posixRel,
          );
          if (outcome.kind !== "pull") {
            return;
          }
          await deps.runWithEngine(
            async (engine, root) => {
              const cfg = await WorkspaceConfigManager.load(root);
              const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === row.workspaceId);
              if (!entry) {
                return;
              }
              await engine.pullFile(cfg, row.workspaceId, outcome.pullRel, entry);
              void vscode.window.showInformationMessage(`Pull ${outcome.pullRel}: готово.`);
            },
            row.root,
            // A panel button is a human acting — same contract as commands.
            { trigger: "user" },
          );
        },
      });
    }),
  ];
}

/**
 * Refresh an already-open panel from local state only — no cloud traffic.
 * Called after operations elsewhere change statuses.
 */
export async function refreshOpenDivergencePanel(deps: DivergencesCommandsDeps): Promise<void> {
  updateDivergencePanel(await loadPlan(deps, false));
}

/**
 * The unobtrusive notice of §626: one non-modal toast when a conflict first
 * shows up in this session, and never again for the same set.
 *
 * Deliberately narrow. The old design had the extension act on divergences;
 * this one has it mention them once and stop. Nothing happens on timeout, and
 * the toast carries no action other than opening the panel.
 */
export function registerDivergenceNotice(
  context: vscode.ExtensionContext,
  deps: DivergencesCommandsDeps,
): void {
  let announcedConflicts = false;

  const check = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted || announcedConflicts) return;
    let counts;
    try {
      counts = summariseDivergences(await loadPlan(deps, false));
    } catch {
      return; // Reading local state failed — nothing worth a toast.
    }
    if (counts.conflict === 0) return;
    announcedConflicts = true;
    const picked = await vscode.window.showInformationMessage(
      `VSCodeSync: ${describeDivergenceCounts(counts)} — расхождений всего ${String(counts.total)}.`,
      "Показать",
    );
    if (picked === "Показать") {
      await vscode.commands.executeCommand("vscodesync.openDivergences");
    }
  };

  // The config file is the detector's output: react to it rather than poll.
  const watcher = vscode.workspace.createFileSystemWatcher("**/.vscode/vscodesync.json");
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => { void check(); }),
    watcher.onDidCreate(() => { void check(); }),
  );
  void check();
}

/** Count divergences without touching the cloud — for callers that need it. */
export async function countDivergences(deps: DivergencesCommandsDeps): Promise<number> {
  return summariseDivergences(await loadPlan(deps, false)).total;
}
