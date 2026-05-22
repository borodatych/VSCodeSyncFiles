/**
 * v0.15 W09 — `.gitignore` re-prompt watcher.
 *
 * Watches `.gitignore` in every workspace folder. When the managed block
 * disappears (after rebase / cherry-pick / `git reset`) it asks the user
 * once per 5-min dedup window whether to re-insert. The pure detector
 * decides what to put back — the watcher only handles the IO.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  detectMissingGitignoreEntries,
  ensureManagedBlock,
} from "../core/gitignoreCoexistence.js";

const DEDUP_MS = 5 * 60_000;

export function registerGitignoreWatcher(context: vscode.ExtensionContext): vscode.Disposable {
  const lastPromptByFolder = new Map<string, number>();

  const checkOne = async (folderFsPath: string): Promise<void> => {
    const gitignorePath = path.join(folderFsPath, ".gitignore");
    let content: string;
    try {
      content = await fs.readFile(gitignorePath, "utf8");
    } catch {
      content = ""; // missing — detect treats as empty
    }
    const report = detectMissingGitignoreEntries(content);
    if (report.recommendation === "none") return;
    const now = Date.now();
    const lastPrompt = lastPromptByFolder.get(folderFsPath) ?? 0;
    if (now - lastPrompt < DEDUP_MS) return;
    lastPromptByFolder.set(folderFsPath, now);
    const verb = report.recommendation === "repair" ? "восстановить" : "добавить";
    const choice = await vscode.window.showInformationMessage(
      `VSCodeSync: в .gitignore (${path.basename(folderFsPath)}) не хватает записей для VSCodeSync. ${verb.charAt(0).toUpperCase() + verb.slice(1)} автоматически?`,
      "Да",
      "Не сейчас",
    );
    if (choice !== "Да") return;
    try {
      const next = ensureManagedBlock(content);
      await fs.writeFile(gitignorePath, next, "utf8");
      void vscode.window.showInformationMessage("VSCodeSync: .gitignore обновлён.");
    } catch (e) {
      await vscode.window.showErrorMessage(
        `VSCodeSync: не удалось обновить .gitignore — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const checkAll = (): void => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      void checkOne(folder.uri.fsPath);
    }
  };

  // Watch on focus regain (covers rebase / reset events without expensive
  // FileSystemWatcher reaches).
  const focusSub = vscode.window.onDidChangeWindowState((s) => {
    if (s.focused) checkAll();
  });
  const foldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    checkAll();
  });
  // Initial pass with 10s delay so we don't fire during activation.
  const t = setTimeout(() => { checkAll(); }, 10_000);

  // v0.17 A8 — do NOT push focusSub/foldersSub into context.subscriptions
  // here. The returned Disposable is already added by the bootstrap site
  // (registerPhase21Bootstrap), so double-pushing causes double-dispose.
  void context; // signal intent: subscriptions managed by caller via return
  return new vscode.Disposable(() => {
    clearTimeout(t);
    focusSub.dispose();
    foldersSub.dispose();
  });
}
