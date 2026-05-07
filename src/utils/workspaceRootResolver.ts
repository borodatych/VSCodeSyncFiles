import * as vscode from "vscode";

/** All workspace roots (multi-root `.code-workspace`). */
export function workspaceRoots(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

/**
 * Default root for engine/commands without explicit folder:
 * single-folder workspace → that folder; multi-root → folder of active editor file if any, else first folder.
 */
export function resolveDefaultWorkspaceRootFsPath(): string | undefined {
  const folders = workspaceRoots();
  if (folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const ed = vscode.window.activeTextEditor?.document.uri;
  if (ed?.scheme === "file") {
    const wf = vscode.workspace.getWorkspaceFolder(ed);
    if (wf) {
      return wf.uri.fsPath;
    }
  }
  return folders[0].uri.fsPath;
}

/**
 * Palette commands that need a concrete project root: multi-root without a focused file in a folder → QuickPick.
 */
export async function resolveWorkspaceRootForPaletteCommand(): Promise<string | undefined> {
  const folders = workspaceRoots();
  if (folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const ed = vscode.window.activeTextEditor?.document.uri;
  if (ed?.scheme === "file") {
    const wf = vscode.workspace.getWorkspaceFolder(ed);
    if (wf) {
      return wf.uri.fsPath;
    }
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath,
      folder: f,
    })),
    { placeHolder: "VSCodeSync: выберите корневую папку проекта" },
  );
  return picked?.folder.uri.fsPath;
}
