/**
 * "Where does this cloud folder go on this machine?" — asked once, when a
 * cloud folder first shows up (docs/v2/linkBindings.md).
 *
 * Two answers cover the user's real cases: **as is** (paths already match —
 * `jscore/**` stays `jscore/**`) and **into my folder** (`php/**` lands in
 * `promed/**`). The second one must accept a folder that does not exist yet:
 * the rule decides where FUTURE files go, and the first pull creates it.
 *
 * Nothing is downloaded here — only a placement rule is written. The files
 * themselves still move by explicit command.
 */
import * as vscode from "vscode";
import { describeFolderIntake, planFolderIntake } from "../core/plan/planFolderIntake.js";
import type { RunWithEngineFn } from "../commands/registerWorkspaceLifecycle.js";

/** Top-level folder prefixes of a manifest (one segment), busiest first. */
export function topLevelFolders(manifestPaths: readonly string[]): { prefix: string; fileCount: number }[] {
  const counts = new Map<string, number>();
  for (const p of manifestPaths) {
    const slash = p.indexOf("/");
    if (slash <= 0) continue;
    const seg = p.slice(0, slash);
    counts.set(seg, (counts.get(seg) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([prefix, fileCount]) => ({ prefix, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.prefix.localeCompare(b.prefix));
}

/**
 * Offers placement for every top-level cloud folder of a freshly attached
 * workspace. Returns how many rules were written.
 */
export async function promptFolderIntakeAfterAttach(
  runWithEngine: RunWithEngineFn,
  root: string,
  workspaceId: string,
  workspaceLabel: string,
): Promise<number> {
  let manifestPaths: string[] = [];
  await runWithEngine(async (engine) => {
    manifestPaths = await engine.listCloudWorkspaceFiles(workspaceId);
  }, root, { trigger: "user" });
  const folders = topLevelFolders(manifestPaths);
  if (folders.length === 0) {
    return 0;
  }

  let bound = 0;
  for (const folder of folders) {
    const choice = await vscode.window.showInformationMessage(
      `«${workspaceLabel}»: облачная папка «${folder.prefix}/» — ${String(folder.fileCount)} файл(ов). Куда её положить на этой машине?`,
      { modal: true },
      "Взять как есть",
      "Положить в свою папку…",
    );
    if (choice === undefined) {
      // Esc == "as is": the default placement is what the sender used, and
      // any folder can be re-bound later from the tree.
      continue;
    }
    if (choice === "Взять как есть") {
      continue;
    }
    const target = await vscode.window.showInputBox({
      title: `VSCodeSync — куда положить «${folder.prefix}/»`,
      prompt: "Путь от корня проекта. Папки может ещё не быть — она создастся при скачивании.",
      value: folder.prefix,
      validateInput: (v) => {
        const t = v.trim().replace(/^\/+|\/+$/g, "");
        if (t === "") return "Путь не может быть пустым";
        if (t.includes("\\")) return "Используйте прямые слэши: promed/modules";
        if (t.split("/").includes("..")) return "«..» в пути недопустим";
        return undefined;
      },
    });
    if (target === undefined) {
      continue;
    }
    const localDirRel = target.trim().replace(/^\/+|\/+$/g, "");
    if (localDirRel === folder.prefix) {
      continue; // same as "as is" — no rule needed
    }
    const plan = planFolderIntake({
      canonicalPrefix: folder.prefix,
      localPrefix: localDirRel,
      manifestPaths,
      localPaths: [],
    });
    const ok = await vscode.window.showInformationMessage(
      `${describeFolderIntake(plan)}\n\nФайлы не скачиваются сейчас — записывается только правило размещения.`,
      { modal: true },
      "Привязать",
    );
    if (ok !== "Привязать") {
      continue;
    }
    await runWithEngine(async (engine) => {
      const res = await engine.bindLocalFolder(workspaceId, folder.prefix, root, { localDirRel });
      bound += 1;
      void vscode.window.showInformationMessage(
        `Папка привязана: ${res.localDirRel}/ ⇄ ${folder.prefix}/. Правило действует и на будущие файлы.`,
      );
    }, root, { trigger: "user" });
  }
  return bound;
}
