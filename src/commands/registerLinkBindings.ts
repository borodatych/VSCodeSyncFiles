/**
 * Link Bindings commands (docs/v2/linkBindings.md, stage 1):
 *
 *  - `vscodesync.bindLocalFile` — bind an existing local file (possibly under
 *    a different path AND name) to a cloud manifest row. Metadata only: no
 *    content moves; divergent content shows up in the «Расхождения» panel and
 *    the user pushes/pulls explicitly.
 *  - `vscodesync.bindLocalFolder` — bind a whole local folder to a canonical
 *    cloud folder with the same inner structure (work `promed/**` ↔ home
 *    `php/**`). The rule also applies to FUTURE files on both sides.
 */
import * as vscode from "vscode";
import { BindRejectedError } from "../core/plan/planBindLocalFile.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";
import { resolveFileTarget } from "./_fileTargetHelpers.js";
import { pickWorkspaceId } from "./_shared.js";

async function pickManifestRow(
  runWithEngine: RunWithEngineFn,
  root: string,
  workspaceId: string,
  localName: string,
): Promise<string | undefined> {
  let paths: string[] = [];
  await runWithEngine(async (engine) => {
    paths = await engine.listCloudWorkspaceFiles(workspaceId);
  }, root);
  if (paths.length === 0) {
    void vscode.window.showWarningMessage("VSCodeSync: в этом воркспейсе нет облачных файлов.");
    return undefined;
  }
  // Same-basename candidates first — the likeliest bind targets.
  const base = localName.toLowerCase();
  const items = [...paths]
    .sort((a, b) => {
      const am = a.toLowerCase().endsWith(`/${base}`) || a.toLowerCase() === base ? 0 : 1;
      const bm = b.toLowerCase().endsWith(`/${base}`) || b.toLowerCase() === base ? 0 : 1;
      return am - bm || a.localeCompare(b);
    })
    .map((p) => ({
      label: p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p,
      description: p,
      value: p,
    }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "VSCodeSync — привязка файла",
    placeHolder: "К какой облачной записи привязать локальный файл?",
    matchOnDescription: true,
  });
  return picked?.value;
}

function bindErrorMessage(e: BindRejectedError): string {
  switch (e.rejection) {
    case "row_not_found":
      return "Файл не найден в облачном манифесте.";
    case "row_deleted":
      return "Файл удалён с облака — привязка невозможна. Добавьте файл в синхронизацию как новый.";
    case "local_path_tracked":
      return `Этот локальный файл уже синхронизируется (облачный ключ: ${e.detail}).`;
    case "already_bound":
      return `Запись уже привязана на этой машине к «${e.detail}».`;
  }
}

/** Distinct directory prefixes of the manifest paths, shallowest first. */
export function manifestDirPrefixes(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      dirs.add(segs.slice(0, i).join("/"));
    }
  }
  return [...dirs].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
}

export interface LinkBindingsCommandsDeps {
  runWithEngine: RunWithEngineFn;
}

export function registerLinkBindingsCommands(deps: LinkBindingsCommandsDeps): vscode.Disposable[] {
  const { runWithEngine } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.bindLocalFile", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const ws = await pickWorkspaceId(target.root);
      if (!ws) {
        return;
      }
      const localName = target.fsPath.split(/[\\/]/).pop() ?? target.fsPath;
      const manifestKey = await pickManifestRow(runWithEngine, target.root, ws, localName);
      if (manifestKey === undefined) {
        return;
      }
      const ok = await vscode.window.showInformationMessage(
        `Привязать «${localName}» к облачной записи «${manifestKey}»?\n\n` +
          "Содержимое не перемещается: при различии версий появится расхождение, " +
          "а отправку или скачивание подтверждаете вы.",
        { modal: true },
        "Привязать",
      );
      if (ok !== "Привязать") {
        return;
      }
      const bindOnce = async (replaceExisting: boolean): Promise<void> => {
        await runWithEngine(async (engine) => {
          const res = await engine.bindLocalFile(ws, manifestKey, target.fsPath, { replaceExisting });
          void vscode.window.showInformationMessage(
            res.contentMatches
              ? `Привязано: ${res.localPosixRel} ⇄ ${manifestKey}. Содержимое совпадает — файлы синхронны.`
              : `Привязано: ${res.localPosixRel} ⇄ ${manifestKey}. Содержимое различается — см. панель «Расхождения».`,
          );
        }, target.root);
      };
      try {
        await bindOnce(false);
      } catch (e) {
        if (e instanceof BindRejectedError && e.rejection === "already_bound") {
          const swap = await vscode.window.showWarningMessage(
            `${bindErrorMessage(e)} Перепривязать к «${localName}»?`,
            { modal: true },
            "Перепривязать",
          );
          if (swap === "Перепривязать") {
            await bindOnce(true);
          }
          return;
        }
        if (e instanceof BindRejectedError) {
          void vscode.window.showErrorMessage(`VSCodeSync: ${bindErrorMessage(e)}`);
          return;
        }
        throw e;
      }
    }),

    vscode.commands.registerCommand("vscodesync.bindLocalFolder", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const ws = await pickWorkspaceId(target.root);
      if (!ws) {
        return;
      }
      let paths: string[] = [];
      await runWithEngine(async (engine) => {
        paths = await engine.listCloudWorkspaceFiles(ws);
      }, target.root);
      const prefixes = manifestDirPrefixes(paths);
      if (prefixes.length === 0) {
        void vscode.window.showWarningMessage("VSCodeSync: в облаке этого воркспейса нет папок для привязки.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        prefixes.map((p) => ({ label: `${p}/`, value: p })),
        {
          title: "VSCodeSync — привязка папки",
          placeHolder: "Какая облачная папка лежит здесь под другим именем?",
        },
      );
      if (!picked) {
        return;
      }
      const localName = target.fsPath.split(/[\\/]/).pop() ?? target.fsPath;
      const ok = await vscode.window.showInformationMessage(
        `Привязать папку «${localName}/» к облачной «${picked.value}/»?\n\n` +
          "Структура внутри считается одинаковой. Правило действует и на будущие файлы: " +
          "новое из облака будет попадать в эту папку, а добавленное отсюда — под облачный префикс. " +
          "Содержимое не перемещается.",
        { modal: true },
        "Привязать",
      );
      if (ok !== "Привязать") {
        return;
      }
      await runWithEngine(async (engine) => {
        const res = await engine.bindLocalFolder(ws, picked.value, target.fsPath);
        void vscode.window.showInformationMessage(
          `Папка привязана: ${res.localDirRel}/ ⇄ ${picked.value}/` +
            (res.reboundTracked > 0 ? ` (перепривязано файлов: ${String(res.reboundTracked)})` : "") +
            ". Новые записи появятся после ближайшей проверки.",
        );
      }, target.root);
    }),
  ];
}
