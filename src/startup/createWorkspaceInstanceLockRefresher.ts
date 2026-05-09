/**
 * v2.6.7 — workspace-instance lock refresher factory.
 *
 * The lock-file mechanism (`{hash}.lock` in `~/.vscode/vscodeSync/`)
 * coordinates multiple VS Code windows looking at the same workspace root.
 * Three triggers refresh the lock list:
 *
 *   - extension activate (initial scan)
 *   - `onDidChangeWorkspaceFolders`
 *   - `onDidChangeWindowState` (when the window regains focus)
 *
 * Each refresh re-walks the current `vscode.workspace.workspaceFolders` and
 * lets `scheduleWorkspaceInstanceLockRefresh` decide what to write to disk.
 * This factory bundles the closure together with the two event subscriptions
 * so `extension.ts` only carries a single one-liner.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { scheduleWorkspaceInstanceLockRefresh } from "../core/workspaceInstanceLock.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";

export interface InstanceLockRefresherDeps {
  readonly globalConfig: GlobalConfigManager;
  readonly statusBar: SyncStatusBarController;
  /** Caller resolves the current workspace folders — typed as a getter so
   *  the closure picks up later mutations (multi-root add/remove). */
  readonly roots: () => readonly vscode.WorkspaceFolder[];
}

export interface InstanceLockRefresher {
  readonly refresh: () => void;
  readonly subscriptions: readonly vscode.Disposable[];
}

export function createWorkspaceInstanceLockRefresher(
  deps: InstanceLockRefresherDeps,
): InstanceLockRefresher {
  const refresh = (): void => {
    scheduleWorkspaceInstanceLockRefresh(
      deps.globalConfig.getStorageDir(),
      deps.roots().map((f) => f.uri.fsPath),
      () => {
        void deps.statusBar.refresh();
      },
    );
  };
  // Trigger the initial scan immediately so callers don't have to repeat it.
  refresh();
  const subscriptions: vscode.Disposable[] = [
    vscode.workspace.onDidChangeWorkspaceFolders(() => { refresh(); }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) refresh();
    }),
  ];
  return { refresh, subscriptions };
}
