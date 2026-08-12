/**
 * Folder-level actions on the workspaces tree (docs/v2/linkBindings.md).
 *
 * A folder node covers dozens of files, so the actions that used to be
 * per-file only — bind elsewhere, pull the missing ones — belong here: the
 * user thinks "put this folder in promed", not "rebind 40 files".
 */
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { describeFolderIntake, planFolderIntake } from "../core/plan/planFolderIntake.js";
import { manifestKeyOf, trackedAbsolutePathFor } from "../core/trackedPathResolver.js";
import type { SyncTreeElement } from "../ui/workspacesTree.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface FolderActionsDeps {
  runWithEngine: RunWithEngineFn;
  refreshUi: () => void | Promise<void>;
}

/** Canonical prefix of a folder node: the badge when bound, the local path otherwise. */
function canonicalPrefixOf(el: Extract<SyncTreeElement, { kind: "fileFolder" }>): string {
  return el.canonicalPrefix ?? el.localPrefix;
}

/**
 * Which target paths already hold a file — the "structure matches" signal and
 * the collision list. Only the mapped subset is probed, so the cost is one
 * `stat` per file of the folder, not of the workspace.
 */
async function existingLocalPaths(
  root: string,
  manifestPaths: readonly string[],
  canonicalPrefix: string,
  localPrefix: string,
): Promise<string[]> {
  const canon = `${canonicalPrefix.replace(/\/+$/, "")}/`;
  const local = localPrefix.replace(/\/+$/, "");
  const out: string[] = [];
  for (const p of manifestPaths) {
    if (!p.startsWith(canon)) continue;
    const target = local === "" ? p.slice(canon.length) : `${local}/${p.slice(canon.length)}`;
    // Through the resolver: `pathMapping` may put synced files in a
    // subdirectory, and a hand-rolled join would probe a path that does not
    // exist there (C13).
    const abs = await trackedAbsolutePathFor(root, target);
    if (abs === undefined) continue;
    try {
      await fs.stat(abs);
      out.push(target);
    } catch {
      /* absent — nothing to collide with */
    }
  }
  return out;
}

export function registerFolderActionsCommands(deps: FolderActionsDeps): vscode.Disposable[] {
  const { runWithEngine, refreshUi } = deps;

  return [
    /**
     * Re-point a whole folder at a different local place: the canonical cloud
     * folder stays as it is, this machine keeps its own name for it (work
     * `promed/**` ⇄ home `php/**`). Future files follow the same rule.
     */
    vscode.commands.registerCommand("vscodesync.treeFolderBind", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "fileFolder") {
        return;
      }
      const canonical = canonicalPrefixOf(el);
      const target = await vscode.window.showInputBox({
        title: "VSCodeSync — где эта папка лежит у вас",
        prompt: `Облачная папка «${canonical}/». Укажите путь от корня проекта — папки может ещё не быть.`,
        value: el.localPrefix,
        validateInput: (v) => {
          const t = v.trim().replace(/^\/+|\/+$/g, "");
          if (t === "") return "Путь не может быть пустым";
          if (t.includes("\\")) return "Используйте прямые слэши: promed/modules";
          if (t.split("/").includes("..")) return "«..» в пути недопустим";
          return undefined;
        },
      });
      if (target === undefined) {
        return;
      }
      const localDirRel = target.trim().replace(/^\/+|\/+$/g, "");

      // Preview before writing: the decision is cheap to make and expensive to
      // undo, so show «cloud → here» and how much of the structure lines up.
      const root = el.folderRoot.fsPath;
      let manifestPaths: string[] = [];
      await runWithEngine(async (engine) => {
        manifestPaths = await engine.listCloudWorkspaceFiles(el.workspaceId);
      }, root);
      const cfg = await WorkspaceConfigManager.load(root);
      const plan = planFolderIntake({
        canonicalPrefix: canonical,
        localPrefix: localDirRel,
        manifestPaths,
        localPaths: await existingLocalPaths(root, manifestPaths, canonical, localDirRel),
        trackedLocalPaths: cfg.files
          .filter((f) => f.workspaceId === el.workspaceId && manifestKeyOf(f) !== f.localPath)
          .map((f) => f.localPath),
      });
      const collisionNote =
        plan.collisions.length > 0
          ? `\n\nУже есть на месте: ${String(plan.collisions.length)} — они не перезапишутся молча, разойдутся в панель «Расхождения».`
          : "";
      const ok = await vscode.window.showInformationMessage(
        `${describeFolderIntake(plan)}${collisionNote}`,
        { modal: true },
        "Привязать",
      );
      if (ok !== "Привязать") {
        return;
      }

      await runWithEngine(async (engine) => {
        const res = await engine.bindLocalFolder(el.workspaceId, canonical, root, {
          localDirRel,
        });
        void vscode.window.showInformationMessage(
          `Папка привязана: ${res.localDirRel}/ ⇄ ${canonical}/` +
            (res.reboundTracked > 0 ? ` (перепривязано файлов: ${String(res.reboundTracked)})` : "") +
            ". Правило действует и на будущие файлы этой папки.",
        );
      }, root);
      await refreshUi();
    }),

    /** Pull every tracked file below this folder that has no bytes on disk. */
    vscode.commands.registerCommand("vscodesync.treeFolderPull", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "fileFolder") {
        return;
      }
      const root = el.folderRoot.fsPath;
      const cfg = await WorkspaceConfigManager.load(root);
      const prefix = `${el.localPrefix}/`;
      const rows = cfg.files.filter(
        (f) => f.workspaceId === el.workspaceId && f.localPath.startsWith(prefix),
      );
      if (rows.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: в этой папке нечего скачивать.");
        return;
      }
      const missing = rows.filter((f) => f.syncStatus === "missing_local");
      const ok = await vscode.window.showInformationMessage(
        `Скачать ${String(rows.length)} файл(ов) папки «${el.localPrefix}/»?` +
          (missing.length > 0 ? `\n\nИз них ещё нет на диске: ${String(missing.length)}.` : ""),
        { modal: true },
        "Скачать",
      );
      if (ok !== "Скачать") {
        return;
      }
      let pulled = 0;
      const failed: string[] = [];
      await runWithEngine(
        async (engine, engineRoot) => {
          const freshCfg = await WorkspaceConfigManager.load(engineRoot);
          const entry = freshCfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
          if (!entry) {
            return;
          }
          for (const f of rows) {
            try {
              await engine.pullFile(freshCfg, el.workspaceId, f.localPath, entry);
              pulled += 1;
            } catch (e) {
              // One unreadable file must not abort the rest of the folder.
              failed.push(`${manifestKeyOf(f)}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        },
        root,
        { cancellable: "VSCodeSync: скачивание папки…" },
      );
      void vscode.window.showInformationMessage(
        failed.length === 0
          ? `Скачано файлов: ${String(pulled)}.`
          : `Скачано ${String(pulled)}, не удалось ${String(failed.length)}. Первая ошибка — ${failed[0] ?? ""}`,
      );
      await refreshUi();
    }),
  ];
}
