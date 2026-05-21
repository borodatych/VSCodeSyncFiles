/**
 * v0.18 W6 — `.vscodesyncrc.json` watcher.
 *
 * Each workspace folder may carry a `.vscodesyncrc.json` file with
 * project-pinned overrides. The engine factory's setting resolvers read
 * from this cache; the cache is refreshed when the file changes.
 *
 * The cache is process-global because the engine factory is created
 * per `runWithEngine` call but operates on whatever workspace folder
 * the user just touched — a per-folder Map keyed by absolute path
 * gives O(1) reads.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseVscodesyncRc, type VscodesyncRc } from "../core/vscodesyncRc.js";

const cache = new Map<string, VscodesyncRc | null>();

/**
 * Returns the parsed rc for a workspace folder, or null when the file is
 * missing / invalid. Read-only — caller passes folder path; mutations
 * happen via the watcher's reload.
 */
export function getVscodesyncRcFor(workspaceRoot: string): VscodesyncRc | null {
  return cache.get(workspaceRoot) ?? null;
}

async function reloadFor(workspaceRoot: string): Promise<void> {
  const filePath = path.join(workspaceRoot, ".vscodesyncrc.json");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    cache.delete(workspaceRoot);
    return;
  }
  const parsed = parseVscodesyncRc(raw);
  if (!parsed.ok) {
    cache.delete(workspaceRoot);
    return;
  }
  cache.set(workspaceRoot, parsed.rc);
  if (parsed.rejectedKeys.length > 0) {
    void vscode.window.showInformationMessage(
      `VSCodeSync: .vscodesyncrc.json в ${path.basename(workspaceRoot)} — ${String(parsed.rejectedKeys.length)} ключ(ей) пропущены (вне allowlist).`,
    );
  }
}

export function registerVscodesyncRcWatcher(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  const subs: vscode.Disposable[] = [];

  const setupForFolder = (folder: vscode.WorkspaceFolder): void => {
    void reloadFor(folder.uri.fsPath);
    const pattern = new vscode.RelativePattern(folder, ".vscodesyncrc.json");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const r = (): void => { void reloadFor(folder.uri.fsPath); };
    subs.push(
      watcher.onDidCreate(r),
      watcher.onDidChange(r),
      watcher.onDidDelete(() => { cache.delete(folder.uri.fsPath); }),
      watcher,
    );
  };

  for (const f of vscode.workspace.workspaceFolders ?? []) setupForFolder(f);
  subs.push(
    vscode.workspace.onDidChangeWorkspaceFolders((ev) => {
      for (const added of ev.added) setupForFolder(added);
      for (const removed of ev.removed) cache.delete(removed.uri.fsPath);
    }),
  );

  const disposable = new vscode.Disposable(() => {
    for (const s of subs) s.dispose();
    cache.clear();
  });
  void context;
  return disposable;
}
