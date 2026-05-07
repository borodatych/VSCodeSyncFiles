import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";

const CTX_TRACKED = "vscodeSync.activeFileTracked";
const CTX_CONFLICT = "vscodeSync.activeFileConflict";

let refreshRef: ((uri?: vscode.Uri) => Promise<void>) | undefined;

/** Вызвать после push/pull/изменения vscodesync.json из команд (меню редактора). */
export async function refreshActiveEditorSyncContext(): Promise<void> {
  await refreshRef?.(vscode.window.activeTextEditor?.document.uri);
}

export function registerActiveEditorSyncContext(context: vscode.ExtensionContext): void {
  const refresh = async (uri?: vscode.Uri): Promise<void> => {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (u?.scheme !== "file") {
      await vscode.commands.executeCommand("setContext", CTX_TRACKED, false);
      await vscode.commands.executeCommand("setContext", CTX_CONFLICT, false);
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(u);
    if (!folder) {
      await vscode.commands.executeCommand("setContext", CTX_TRACKED, false);
      await vscode.commands.executeCommand("setContext", CTX_CONFLICT, false);
      return;
    }
    try {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      const rel = path.relative(folder.uri.fsPath, u.fsPath).split(path.sep).join("/");
      const tf = wc.files.find((f) => f.localPath === rel);
      await vscode.commands.executeCommand("setContext", CTX_TRACKED, tf !== undefined);
      await vscode.commands.executeCommand("setContext", CTX_CONFLICT, tf?.syncStatus === "conflict");
    } catch {
      await vscode.commands.executeCommand("setContext", CTX_TRACKED, false);
      await vscode.commands.executeCommand("setContext", CTX_CONFLICT, false);
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      void refresh(ed?.document.uri);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refresh(vscode.window.activeTextEditor?.document.uri);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const norm = doc.uri.fsPath.replace(/\\/g, "/").toLowerCase();
      if (norm.endsWith("/.vscode/vscodesync.json")) {
        void refresh(vscode.window.activeTextEditor?.document.uri);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync")) {
        void refresh(vscode.window.activeTextEditor?.document.uri);
      }
    }),
  );
  refreshRef = refresh;
  void refresh();
}
