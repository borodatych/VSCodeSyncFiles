/**
 * File-target resolvers — handle the three command-arg shapes a file
 * action might receive: `vscode.Uri`, undefined (active editor), or a
 * tree `SyncTreeElement`.
 *
 * Lifted out of extension.ts as part of v2.6.7 (extension.ts < 500 LoC
 * goal). Pure top-level functions.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { trackedLocalAbsolutePath } from "../core/pathMapping.js";
import type { SyncTreeElement } from "../ui/workspacesTree.js";

/** Resolve a `{ root, fsPath }` from the active editor or via showOpenDialog
 * fallback. Surfaces a warning if the file lives outside any open folder. */
export async function resolveFileTarget(
  uri: vscode.Uri | undefined,
): Promise<{ root: string; fsPath: string } | undefined> {
  let u = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (u?.scheme !== "file") {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: "Выбрать файл или папку",
      title: "VSCodeSync: выберите файл или папку",
    });
    u = picked?.[0];
    if (u?.scheme !== "file") {
      return undefined;
    }
  }
  const folder = vscode.workspace.getWorkspaceFolder(u);
  if (!folder) {
    await vscode.window.showWarningMessage("VSCodeSync: файл вне открытой папки workspace.");
    return undefined;
  }
  return { root: folder.uri.fsPath, fsPath: u.fsPath };
}

/** Command handler may receive a `Uri`, nothing (active editor), or a tree
 * `SyncTreeElement`. Loose variant — accepts unknown arg, dispatches to the
 * right path. */
export async function resolveFileTargetLoose(
  globalConfig: GlobalConfigManager,
  arg?: unknown,
): Promise<{ root: string; fsPath: string } | undefined> {
  if (arg && typeof arg === "object" && "kind" in arg && (arg as SyncTreeElement).kind === "file") {
    const el = arg as SyncTreeElement & { kind: "file" };
    const wc = await WorkspaceConfigManager.load(el.folderRoot.fsPath);
    const gc = await globalConfig.load();
    const fsPath = trackedLocalAbsolutePath(el.folderRoot.fsPath, wc.pathMapping, gc.machineName, el.localPath);
    return { root: el.folderRoot.fsPath, fsPath };
  }
  if (arg instanceof vscode.Uri) {
    return resolveFileTarget(arg);
  }
  return resolveFileTarget(undefined);
}
