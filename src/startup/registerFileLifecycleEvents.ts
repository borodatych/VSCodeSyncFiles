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
          // Both branches run only after the user answered the prompt above.
          await runWithEngine(async (engine) => {
            await engine.removeTrackedFiles(fileEntry.workspaceId, [fsPath]);
          }, root, { trigger: "user" });
        } else {
          // Restore means "bring back the file the user just deleted" — not
          // `pullAll`, which force-pulls the whole workspace past detectChange
          // and silently overwrites unsynced edits in every other file (D6).
          await runWithEngine(async (engine) => {
            const cfg = await WorkspaceConfigManager.load(root);
            const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === fileEntry.workspaceId);
            if (!entry) {
              await vscode.window.showErrorMessage("VSCodeSync: workspace не найден в конфиге.");
              return;
            }
            const result = await engine.pullFile(cfg, fileEntry.workspaceId, rel, entry);
            void vscode.window.showInformationMessage(
              result === "already_current"
                ? `VSCodeSync: «${rel}» уже актуален.`
                : `VSCodeSync: «${rel}» восстановлен из облака.`,
            );
          }, root, { trigger: "user" });
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
          // A rename is the user acting on their own file; the event is VS Code
          // reporting it, not the extension deciding to move anything.
          await runWithEngine(async (engine) => {
            await engine.untrackFileLocal(fileEntry.workspaceId, [oldUri.fsPath]);
          }, root, { trigger: "user" });
          continue;
        }
        await runWithEngine(async (engine) => {
          await engine.renameTrackedFile(fileEntry.workspaceId, oldUri.fsPath, newUri.fsPath);
        }, root, { trigger: "user" });
      }
    }),
  );

  registerSoftLockLifecycle(context, runWithEngine);
}

/**
 * Soft-Lock lifecycle (B4).
 *
 * Behind `vscodesync.softLock.enabled`, default *off*: announcing "I am
 * editing this file" costs two cloud round-trips (manifest download + upload)
 * per tab switch, which only makes sense in explicit collaboration. Turning
 * the setting on is the user's consent to that traffic.
 *
 * The 10-minute heartbeat and the 60-minute auto-clear timers are gone, not
 * gated: both were pure timer paths (the mutation checkpoint would refuse
 * them anyway), and both duties are already covered elsewhere — a lock that
 * stops being refreshed goes stale for readers via `softLockStaleHours`, and
 * closing the document clears it explicitly. The next real user action
 * (tab switch, edit) re-announces presence by itself.
 */
function registerSoftLockLifecycle(
  context: vscode.ExtensionContext,
  runWithEngine: RunWithEngineFn,
): void {
  const softLockRegistry = new Map<string, { root: string; workspaceId: string; relPath: string }>();
  const SOFT_LOCK_DEBOUNCE_MS = 1500;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const softLockEnabled = (): boolean =>
    vscode.workspace.getConfiguration("vscodesync").get<boolean>("softLock.enabled", false);

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
    });
    // Opening or editing a file is the user being present in it — that is
    // what a soft lock announces.
    await runWithEngine(async (engine) => {
      await engine.setSoftLock(fileEntry.workspaceId, rel);
    }, root, { showErrorDialog: false, trigger: "user" });
  };

  const clearSoftLockForUri = async (uri: vscode.Uri): Promise<void> => {
    const entry = softLockRegistry.get(uri.fsPath);
    if (!entry) return;
    softLockRegistry.delete(uri.fsPath);
    await runWithEngine(async (engine) => {
      await engine.clearSoftLock(entry.workspaceId, entry.relPath);
    }, entry.root, { showErrorDialog: false, trigger: "user" });
  };

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    }),
    // Not awaited and debounced: flipping through five tabs must not fire
    // five manifest uploads, and the event handler must not block on I/O.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!softLockEnabled()) return;
      if (editor?.document.uri.scheme !== "file") return;
      const uri = editor.document.uri;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void setSoftLockForUri(uri).catch(() => { /* non-fatal */ });
      }, SOFT_LOCK_DEBOUNCE_MS);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // Clear regardless of the setting: a lock set before the setting was
      // turned off must still be removable.
      if (doc.uri.scheme === "file") {
        void clearSoftLockForUri(doc.uri).catch(() => { /* non-fatal */ });
      }
    }),
  );
}
