/**
 * File lifecycle events + Soft-Lock lifecycle — extracted from `extension.ts`
 * (Phase 0 / v2.11.3).
 *
 * Two related subscriptions that operate on the same VS Code FS / editor
 * events but with different semantics:
 *   - File deletions / renames of tracked files surface as a 3-way prompt
 *     (untrack / restore / ignore) and a rename-driven `renameTrackedFile` /
 *     `untrackFileLocal` engine call.
 *   - Soft-Lock lifecycle keeps a per-session `Map<fsPath, entry>` registry,
 *     pings the cloud manifest's `editingBy` field on activity, and clears
 *     after 60 min idle (or on document close).
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { RunWithEngineFn } from "../commands/registerWorkspaceLifecycle.js";

export interface FileLifecycleEventsDeps {
  context: vscode.ExtensionContext;
  runWithEngine: RunWithEngineFn;
}

export function registerFileLifecycleEvents(deps: FileLifecycleEventsDeps): void {
  const { context, runWithEngine } = deps;

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles(async (e) => {
      for (const fileUri of e.files) {
        const fsPath = fileUri.fsPath;
        const folder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!folder) continue;
        const root = folder.uri.fsPath;
        const wc = await WorkspaceConfigManager.load(root);
        const rel = path.relative(root, fsPath).split(path.sep).join("/");
        const fileEntry = wc.files.find((f) => f.localPath === rel);
        if (!fileEntry) continue;
        const choice = await vscode.window.showWarningMessage(
          `VSCodeSync: «${path.basename(fsPath)}» удалён локально. Что сделать с синхронизацией?`,
          "Убрать из синхронизации",
          "Восстановить файл",
          "Ничего",
        );
        if (!choice || choice === "Ничего") continue;
        if (choice === "Убрать из синхронизации") {
          await runWithEngine(async (engine) => {
            await engine.removeTrackedFiles(fileEntry.workspaceId, [fsPath]);
          }, root);
        } else {
          await runWithEngine(async (engine) => {
            await engine.pullAll(fileEntry.workspaceId);
          }, root);
        }
      }
    }),

    vscode.workspace.onDidRenameFiles(async (e) => {
      for (const { oldUri, newUri } of e.files) {
        const folder = vscode.workspace.getWorkspaceFolder(oldUri);
        if (!folder) continue;
        const root = folder.uri.fsPath;
        const wc = await WorkspaceConfigManager.load(root);
        const oldRel = path.relative(root, oldUri.fsPath).split(path.sep).join("/");
        const fileEntry = wc.files.find((f) => f.localPath === oldRel);
        if (!fileEntry) continue;
        const newFolder = vscode.workspace.getWorkspaceFolder(newUri);
        if (newFolder?.uri.fsPath !== root) {
          // Moved outside workspace — untrack locally
          await runWithEngine(async (engine) => {
            await engine.untrackFileLocal(fileEntry.workspaceId, [oldUri.fsPath]);
          }, root);
          continue;
        }
        await runWithEngine(async (engine) => {
          await engine.renameTrackedFile(fileEntry.workspaceId, oldUri.fsPath, newUri.fsPath);
        }, root);
      }
    }),
  );

  registerSoftLockLifecycle(context, runWithEngine);
}

function registerSoftLockLifecycle(
  context: vscode.ExtensionContext,
  runWithEngine: RunWithEngineFn,
): void {
  const softLockRegistry = new Map<string, { root: string; workspaceId: string; relPath: string; lastActivityMs: number }>();
  const SOFT_LOCK_TIMEOUT_MS = 60 * 60 * 1000; // 60 min without activity → auto-clear
  const SOFT_LOCK_HEARTBEAT_MS = 10 * 60 * 1000; // refresh every 10 min of active editing

  const setSoftLockForUri = async (uri: vscode.Uri): Promise<void> => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const root = folder.uri.fsPath;
    const wc = await WorkspaceConfigManager.load(root);
    const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
    const fileEntry = wc.files.find((f) => f.localPath === rel);
    if (!fileEntry) return;
    softLockRegistry.set(uri.fsPath, {
      root,
      workspaceId: fileEntry.workspaceId,
      relPath: rel,
      lastActivityMs: Date.now(),
    });
    await runWithEngine(async (engine) => {
      await engine.setSoftLock(fileEntry.workspaceId, rel);
    }, root, { showErrorDialog: false });
  };

  const clearSoftLockForUri = async (uri: vscode.Uri): Promise<void> => {
    const entry = softLockRegistry.get(uri.fsPath);
    if (!entry) return;
    softLockRegistry.delete(uri.fsPath);
    await runWithEngine(async (engine) => {
      await engine.clearSoftLock(entry.workspaceId, entry.relPath);
    }, entry.root, { showErrorDialog: false });
  };

  const heartbeatHandle = setInterval(() => {
    const now = Date.now();
    for (const [fsPath, entry] of softLockRegistry) {
      if (now - entry.lastActivityMs > SOFT_LOCK_TIMEOUT_MS) {
        softLockRegistry.delete(fsPath);
        void runWithEngine(async (engine) => {
          await engine.clearSoftLock(entry.workspaceId, entry.relPath);
        }, entry.root, { showErrorDialog: false });
      } else if (now - entry.lastActivityMs > SOFT_LOCK_HEARTBEAT_MS) {
        // Refresh cloud lock without resetting the inactivity timer — only real edits do that.
        void runWithEngine(async (engine) => {
          await engine.setSoftLock(entry.workspaceId, entry.relPath);
        }, entry.root, { showErrorDialog: false });
      }
    }
  }, SOFT_LOCK_HEARTBEAT_MS);

  context.subscriptions.push(
    new vscode.Disposable(() => { clearInterval(heartbeatHandle); }),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor?.document.uri.scheme === "file") {
        await setSoftLockForUri(editor.document.uri).catch(() => { /* non-fatal */ });
      }
    }),
    vscode.workspace.onDidCloseTextDocument(async (doc) => {
      if (doc.uri.scheme === "file") {
        await clearSoftLockForUri(doc.uri).catch(() => { /* non-fatal */ });
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const entry = softLockRegistry.get(e.document.uri.fsPath);
      if (entry) {
        entry.lastActivityMs = Date.now();
      }
    }),
  );
}
