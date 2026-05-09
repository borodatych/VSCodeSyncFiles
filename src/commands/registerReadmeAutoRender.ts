/**
 * `.vscodesync-readme.md` auto-render command + first-open watcher (v2.20.5).
 *
 * Two surfaces:
 *   - `vscodesync.showWorkspaceReadme` — explicit command. Reads
 *     `.vscodesync-readme.md` from the active workspace folder and renders
 *     it via {@link renderWorkspaceReadmeHtml}. Missing file surfaces a
 *     friendly hint with a "Create one" template option.
 *   - One-shot first-open auto-render: when a workspace contains the file
 *     and this is the first activate on this machine for this workspace
 *     (tracked via `globalState`), the webview opens automatically.
 *
 * The renderer module is `vscode`-free; this wrapper only does I/O + webview
 * management.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderWorkspaceReadmeHtml } from "../core/workspaceReadmeMd.js";

const SHOW_COMMAND = "vscodesync.showWorkspaceReadme";
const FILE_NAME = ".vscodesync-readme.md";
const SEEN_KEY_PREFIX = "vscodesync.readmeAutoRender.seen:";

const DEFAULT_TEMPLATE = `# Workspace welcome

This file is rendered automatically by **VSCodeSync** the first time the workspace
is opened on a new machine. Document anything teammates should know:

- Where to start
- Channels for questions
- Build / test commands
- Recent decisions

Tip: keep it short — the welcome screen is for *orientation*, not full docs.
`;

export interface ReadmeAutoRenderDeps {
  context: vscode.ExtensionContext;
}

export function registerReadmeAutoRender(deps: ReadmeAutoRenderDeps): vscode.Disposable[] {
  const { context } = deps;

  void runFirstOpenAutoRender(context);

  return [
    vscode.commands.registerCommand(SHOW_COMMAND, () => runShow(context)),
  ];
}

async function runShow(context: vscode.ExtensionContext): Promise<void> {
  const folder = pickWorkspaceFolder();
  if (!folder) {
    await vscode.window.showErrorMessage("VSCodeSync: откройте папку workspace.");
    return;
  }
  const filePath = path.join(folder.uri.fsPath, FILE_NAME);
  const md = await readReadme(filePath);
  if (md === null) {
    const choice = await vscode.window.showInformationMessage(
      `VSCodeSync: файл ${FILE_NAME} не найден в текущей папке.`,
      "Создать шаблон",
      "Отмена",
    );
    if (choice === "Создать шаблон") {
      await fs.writeFile(filePath, DEFAULT_TEMPLATE, "utf8");
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }
    return;
  }
  showReadmeWebview(context, folder.name, md);
}

async function runFirstOpenAutoRender(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const seenKey = `${SEEN_KEY_PREFIX}${folder.uri.fsPath}`;
    if (context.globalState.get<boolean>(seenKey, false)) continue;
    const filePath = path.join(folder.uri.fsPath, FILE_NAME);
    const md = await readReadme(filePath);
    if (md === null) {
      // No README → don't re-poll on every activate.
      await context.globalState.update(seenKey, true);
      continue;
    }
    await context.globalState.update(seenKey, true);
    showReadmeWebview(context, folder.name, md);
  }
}

async function readReadme(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function showReadmeWebview(
  context: vscode.ExtensionContext,
  workspaceLabel: string,
  md: string,
): void {
  const panel = vscode.window.createWebviewPanel(
    "vscodesync.workspaceReadme",
    `VSCodeSync · ${workspaceLabel}`,
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: false },
  );
  panel.webview.html = renderWorkspaceReadmeHtml(md, { workspaceLabel });
  context.subscriptions.push(panel);
}

function pickWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : undefined;
}
