/**
 * Canonical path editing — the command surface (docs/v3/canonicalPaths.md).
 *
 * Three entry points funnel into ONE flow: single-node rename (file or
 * folder), the mass path editor, and tree drag-and-drop (wired in
 * `workspacesTreeDnD`). The flow is always: compose requests →
 * `planCanonicalRename` preview (counts, collisions, warnings) → one modal →
 * `engine.renameCanonicalKeys` with progress. Local bytes never move — on any
 * machine; the cloud tree is what changes.
 *
 * Interrupted jobs persist in `workspaceState` and resume by re-running the
 * same requests — the engine flow is idempotent, so «Возобновить перенос»
 * simply retries.
 */
import * as vscode from "vscode";
import {
  isValidCanonicalPath,
  planCanonicalRename,
  type CanonicalRenameRequest,
  type PlannedCanonicalRename,
} from "../core/plan/planCanonicalRename.js";
import type { SyncTreeElement } from "../ui/workspacesTree.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface CanonicalRenameDeps {
  context: vscode.ExtensionContext;
  runWithEngine: RunWithEngineFn;
  refreshUi: () => void | Promise<void>;
}

const PENDING_KEY = "vscodesync.pendingCanonicalRename";
const LAST_BATCH_KEY = "vscodesync.lastCanonicalRename";

interface PendingRenameJob {
  root: string;
  workspaceId: string;
  requests: CanonicalRenameRequest[];
  startedAt: string;
}

/** The applied moves of the last successful batch — the undo material. */
interface LastRenameBatch {
  root: string;
  workspaceId: string;
  applied: { from: string; to: string }[];
  finishedAt: string;
}

/** Mass-editor sessions, keyed by document URI. */
interface PathsEditSession {
  root: string;
  workspaceId: string;
  workspaceNote: string;
  original: string[];
}

const editSessions = new Map<string, PathsEditSession>();

function validatePathInput(v: string): string | undefined {
  const t = v.trim();
  if (t === "") return "Путь не может быть пустым";
  if (!isValidCanonicalPath(t)) return "POSIX-путь без «..», «.», «\\» и пустых сегментов";
  return undefined;
}

/** Human summary of a plan for the confirmation modal. */
export function describeRenamePlan(plan: PlannedCanonicalRename): string {
  const lines: string[] = [];
  const sample = plan.moves.slice(0, 5).map((m) => `${m.from} → ${m.to}`);
  lines.push(`Переездов: ${String(plan.moves.length)}`);
  lines.push(...sample);
  if (plan.moves.length > 5) lines.push(`…и ещё ${String(plan.moves.length - 5)}`);
  const caseOnly = plan.warnings.filter((w) => w.kind === "case-only").length;
  if (caseOnly > 0) {
    lines.push(`⚠ Различие только в регистре (${String(caseOnly)}) — OneDrive/Google Drive нечувствительны к регистру.`);
  }
  const catChanges = plan.warnings.filter((w) => w.kind === "hash-category-change").length;
  if (catChanges > 0) {
    lines.push(
      `⚠ Смена категории текст↔бинарь (${String(catChanges)}): нормализация переводов строк отключается — ` +
        "машины с другими CRLF увидят реальное расхождение содержимого, не только пересчёт хэша.",
    );
  }
  const tombs = plan.warnings.filter((w) => w.kind === "tombstone-target").length;
  if (tombs > 0) {
    lines.push(`Путей, освободившихся после удаления: ${String(tombs)} — будут переиспользованы.`);
  }
  lines.push("", "Локальные файлы не перемещаются ни на одной машине; привязки сохраняются (linkId).");
  return lines.join("\n");
}

function describeProblem(p: PlannedCanonicalRename["problems"][number]): string {
  switch (p.kind) {
    case "invalid-path":
      return `недопустимый путь «${p.path}»`;
    case "missing-source":
      return `в облаке нет «${p.request.from}»`;
    case "duplicate-target":
      return `несколько файлов метят в «${p.to}» (${p.froms.join(", ")})`;
    case "collision":
      return `«${p.move.to}» уже занят живым файлом`;
  }
}

/** The one shared confirm-and-run flow behind every entry point (DnD included). */
export async function confirmAndRunCanonicalRename(
  deps: CanonicalRenameDeps,
  root: string,
  workspaceId: string,
  requests: CanonicalRenameRequest[],
  opts: { skipConfirm?: boolean } = {},
): Promise<void> {
  let livePaths: string[] = [];
  await deps.runWithEngine(async (engine) => {
    livePaths = await engine.listCloudWorkspaceFiles(workspaceId);
  }, root, { trigger: "user" });
  const plan = planCanonicalRename(livePaths.map((path) => ({ path })), requests);
  if (plan.problems.length > 0) {
    void vscode.window.showErrorMessage(
      `VSCodeSync: переезд невозможен — ${plan.problems.slice(0, 3).map(describeProblem).join("; ")}${plan.problems.length > 3 ? " …" : ""}`,
    );
    return;
  }
  if (plan.moves.length === 0) {
    void vscode.window.showInformationMessage("VSCodeSync: пути уже такие — переносить нечего.");
    return;
  }
  if (!opts.skipConfirm) {
    const ok = await vscode.window.showInformationMessage(
      "VSCodeSync — изменить канонические пути?",
      { modal: true, detail: describeRenamePlan(plan) },
      "Переименовать",
    );
    if (ok !== "Переименовать") {
      return;
    }
  }
  const job: PendingRenameJob = { root, workspaceId, requests, startedAt: new Date().toISOString() };
  await deps.context.workspaceState.update(PENDING_KEY, job);
  try {
    let applied: { from: string; to: string }[] = [];
    let skipped = 0;
    await deps.runWithEngine(
      async (engine) => {
        const res = await engine.renameCanonicalKeys(workspaceId, requests);
        applied = res.applied;
        skipped = res.skipped.length;
      },
      root,
      { cancellable: "VSCodeSync: перенос канонических путей…", trigger: "user" },
    );
    await deps.context.workspaceState.update(PENDING_KEY, undefined);
    if (applied.length > 0) {
      const batch: LastRenameBatch = { root, workspaceId, applied, finishedAt: new Date().toISOString() };
      await deps.context.workspaceState.update(LAST_BATCH_KEY, batch);
    }
    const choice = await vscode.window.showInformationMessage(
      `VSCodeSync: пути обновлены (${String(applied.length)})${skipped > 0 ? `, пропущено: ${String(skipped)}` : ""}. Локальные файлы не перемещались.`,
      ...(applied.length > 0 ? ["Отменить переименование"] : []),
    );
    if (choice === "Отменить переименование") {
      await vscode.commands.executeCommand("vscodesync.undoCanonicalRename");
      return;
    }
  } catch (e) {
    // The job stays persisted: every step is idempotent, so re-running the
    // same requests finishes what the interruption left half-done.
    const choice = await vscode.window.showErrorMessage(
      `VSCodeSync: перенос прерван — ${e instanceof Error ? e.message : String(e)}. Облако останется согласованным после возобновления.`,
      "Возобновить перенос",
    );
    if (choice === "Возобновить перенос") {
      await vscode.commands.executeCommand("vscodesync.resumeCanonicalRename");
      return;
    }
  }
  await deps.refreshUi();
}

export function registerCanonicalRenameCommands(deps: CanonicalRenameDeps): vscode.Disposable[] {
  return [
    /** Single file: edit its canonical (cloud) path, bytes stay everywhere. */
    vscode.commands.registerCommand(
      "vscodesync.treeEditCanonicalPath",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "file") {
          return;
        }
        const canonical = el.manifestPath ?? el.localPath;
        const target = await vscode.window.showInputBox({
          title: "VSCodeSync — канонический путь в облаке",
          prompt:
            "Путь, под которым файл живёт в воркспейсе. Привязки машин не изменятся; локальные файлы не перемещаются.",
          value: canonical,
          validateInput: validatePathInput,
        });
        if (target === undefined) {
          return;
        }
        const to = target.trim();
        if (to === canonical) {
          return;
        }
        await confirmAndRunCanonicalRename(deps, el.folderRoot.fsPath, el.workspaceId, [
          { scope: "file", from: canonical, to },
        ]);
      },
    ),

    /** Folder (any node, root included): prefix rename — children follow. */
    vscode.commands.registerCommand(
      "vscodesync.treeRenameCloudFolder",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "fileFolder") {
          return;
        }
        // In canonical tree mode the grouping prefix IS the cloud prefix.
        const canonical =
          el.space === "canonical" ? el.localPrefix : (el.canonicalPrefix ?? el.localPrefix);
        const target = await vscode.window.showInputBox({
          title: "VSCodeSync — канонический путь папки в облаке",
          prompt:
            "Все дочерние пути перестроятся. Привязки машин не изменятся; локальные файлы не перемещаются.",
          value: canonical,
          validateInput: validatePathInput,
        });
        if (target === undefined) {
          return;
        }
        const to = target.trim();
        if (to === canonical) {
          return;
        }
        await confirmAndRunCanonicalRename(deps, el.folderRoot.fsPath, el.workspaceId, [
          { scope: "prefix", from: canonical, to },
        ]);
      },
    ),

    /**
     * Mass editor: every canonical path of the workspace, one per line, edited
     * as text (multi-cursor, regex replace — the editor is the UI). Applied as
     * one batch through the same preview and confirmation.
     */
    vscode.commands.registerCommand(
      "vscodesync.editWorkspacePaths",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const root = el.folderRoot.fsPath;
        let livePaths: string[] = [];
        await deps.runWithEngine(async (engine) => {
          livePaths = await engine.listCloudWorkspaceFiles(el.workspaceId);
        }, root, { trigger: "user" });
        if (livePaths.length === 0) {
          void vscode.window.showInformationMessage("VSCodeSync: в воркспейсе нет файлов.");
          return;
        }
        const original = [...livePaths].sort((a, b) => a.localeCompare(b));
        const header = [
          `# VSCodeSync — пути воркспейса «${el.note}» (${el.workspaceId})`,
          "# Правьте строки как текст. Число и порядок строк менять нельзя.",
          "# Применить: команда «VSCodeSync: Применить правки путей воркспейса».",
          "",
        ];
        const doc = await vscode.workspace.openTextDocument({
          language: "plaintext",
          content: [...header, ...original].join("\n"),
        });
        editSessions.set(doc.uri.toString(), {
          root,
          workspaceId: el.workspaceId,
          workspaceNote: el.note,
          original,
        });
        await vscode.window.showTextDocument(doc, { preview: false });
        const pick = await vscode.window.showInformationMessage(
          "VSCodeSync: правьте пути в открытом документе, затем примените.",
          "Применить правки",
        );
        if (pick === "Применить правки") {
          await vscode.commands.executeCommand("vscodesync.applyWorkspacePathsEdit");
        }
      },
    ),

    /** Apply the mass editor's buffer as one canonical-rename batch. */
    vscode.commands.registerCommand("vscodesync.applyWorkspacePathsEdit", async () => {
      const editor = vscode.window.activeTextEditor;
      const fromActive = editor ? editSessions.get(editor.document.uri.toString()) : undefined;
      const fallback = editSessions.size === 1 ? [...editSessions.entries()][0] : undefined;
      const entry = fromActive
        ? ([editor!.document.uri.toString(), fromActive] as const)
        : fallback;
      if (!entry) {
        void vscode.window.showErrorMessage(
          "VSCodeSync: нет открытой сессии правки путей. Начните с «Редактировать пути воркспейса…».",
        );
        return;
      }
      const [uriKey, session] = entry;
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriKey);
      if (!doc) {
        editSessions.delete(uriKey);
        void vscode.window.showErrorMessage("VSCodeSync: документ правки путей закрыт — сессия сброшена.");
        return;
      }
      const lines = doc
        .getText()
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
      if (lines.length !== session.original.length) {
        void vscode.window.showErrorMessage(
          `VSCodeSync: строк ${String(lines.length)}, а файлов ${String(session.original.length)} — строки соответствуют файлам по позиции, добавлять и удалять их нельзя.`,
        );
        return;
      }
      const requests: CanonicalRenameRequest[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== session.original[i]) {
          requests.push({ scope: "file", from: session.original[i], to: lines[i] });
        }
      }
      if (requests.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: изменений нет.");
        return;
      }
      await confirmAndRunCanonicalRename(deps, session.root, session.workspaceId, requests);
      editSessions.delete(uriKey);
    }),

    /**
     * Undo the last batch: the inverse moves run through the SAME machinery —
     * cheap while the `renamedFrom` breadcrumbs are alive (30 days), and the
     * safety net the mass editor deserves.
     */
    vscode.commands.registerCommand("vscodesync.undoCanonicalRename", async () => {
      const batch = deps.context.workspaceState.get<LastRenameBatch>(LAST_BATCH_KEY);
      if (!batch || batch.applied.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: отменять нечего — последних переносов нет.");
        return;
      }
      const inverse: CanonicalRenameRequest[] = batch.applied.map((m) => ({
        scope: "file",
        from: m.to,
        to: m.from,
      }));
      await deps.context.workspaceState.update(LAST_BATCH_KEY, undefined);
      await confirmAndRunCanonicalRename(deps, batch.root, batch.workspaceId, inverse);
    }),

    /** Retry an interrupted batch — the flow is idempotent end to end. */
    vscode.commands.registerCommand("vscodesync.resumeCanonicalRename", async () => {
      const job = deps.context.workspaceState.get<PendingRenameJob>(PENDING_KEY);
      if (!job) {
        void vscode.window.showInformationMessage("VSCodeSync: прерванных переносов нет.");
        return;
      }
      await confirmAndRunCanonicalRename(deps, job.root, job.workspaceId, job.requests, { skipConfirm: true });
    }),
  ];
}

/** Boot-time nudge: an interrupted rename job survives restarts. */
export function offerResumePendingCanonicalRename(context: vscode.ExtensionContext): void {
  const job = context.workspaceState.get<PendingRenameJob>(PENDING_KEY);
  if (!job) {
    return;
  }
  void (async () => {
    const choice = await vscode.window.showWarningMessage(
      `VSCodeSync: перенос канонических путей (${job.startedAt.slice(0, 16)}) был прерван. Возобновить?`,
      "Возобновить перенос",
      "Отменить и забыть",
    );
    if (choice === "Возобновить перенос") {
      await vscode.commands.executeCommand("vscodesync.resumeCanonicalRename");
    } else if (choice === "Отменить и забыть") {
      await context.workspaceState.update(PENDING_KEY, undefined);
    }
  })();
}
