/**
 * Link Bindings (stage 2) — shared placement chooser for a tracked file that
 * has no bytes on this machine yet (`missing_local`). Three outcomes: keep the
 * recorded placement, pick a custom folder+name (bind, then the caller
 * pulls), or bind to an existing local file (no download). Used by the tree
 * pull and the bulk-pull "разобрать по одному" path.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export type PlacementOutcome =
  | { kind: "pull"; pullRel: string }
  | { kind: "bound_no_pull" }
  | { kind: "cancelled" };

export async function chooseMissingFilePlacement(
  runWithEngine: RunWithEngineFn,
  rootUri: vscode.Uri,
  workspaceId: string,
  localPath: string,
  manifestKey: string,
): Promise<PlacementOutcome> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: `Сюда: ${localPath}`, description: "как записано", value: "default" as const },
      { label: "Выбрать папку и имя…", description: "скачать в своё место (привязка)", value: "custom" as const },
      { label: "Привязать к существующему файлу…", description: "без скачивания", value: "bind" as const },
    ],
    { title: "VSCodeSync — куда положить файл?", placeHolder: manifestKey },
  );
  if (!picked) {
    return { kind: "cancelled" };
  }
  if (picked.value === "default") {
    return { kind: "pull", pullRel: localPath };
  }
  const baseName = manifestKey.includes("/") ? manifestKey.slice(manifestKey.lastIndexOf("/") + 1) : manifestKey;
  let targetAbs: string | undefined;
  if (picked.value === "bind") {
    const files = await vscode.window.showOpenDialog({
      title: "Локальный файл для привязки",
      defaultUri: rootUri,
      canSelectMany: false,
    });
    targetAbs = files?.[0]?.fsPath;
  } else {
    const dirs = await vscode.window.showOpenDialog({
      title: "Папка для файла",
      defaultUri: rootUri,
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
    });
    const dir = dirs?.[0]?.fsPath;
    if (dir !== undefined) {
      const name = await vscode.window.showInputBox({
        title: "Имя файла на этой машине",
        value: baseName,
      });
      if (name !== undefined && name !== "") {
        targetAbs = path.join(dir, name);
      }
    }
  }
  if (targetAbs === undefined) {
    return { kind: "cancelled" };
  }
  let bound: { localPosixRel: string; contentMatches: boolean } | undefined;
  await runWithEngine(async (engine) => {
    bound = await engine.bindLocalFile(workspaceId, manifestKey, targetAbs, { replaceExisting: true });
  }, rootUri.fsPath);
  if (bound === undefined) {
    return { kind: "cancelled" };
  }
  if (picked.value === "bind") {
    void vscode.window.showInformationMessage(
      bound.contentMatches
        ? `Привязано: ${bound.localPosixRel} ⇄ ${manifestKey}. Содержимое совпадает.`
        : `Привязано: ${bound.localPosixRel} ⇄ ${manifestKey}. Содержимое различается — см. панель «Расхождения».`,
    );
    return { kind: "bound_no_pull" };
  }
  return { kind: "pull", pullRel: bound.localPosixRel };
}
