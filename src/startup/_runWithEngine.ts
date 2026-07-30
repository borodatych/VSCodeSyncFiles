/**
 * `runWithEngine` factory — extracted from `extension.ts` (Phase 0 / v2.11.2).
 *
 * Builds the closure that every command bundle uses to acquire a `SyncEngine`,
 * resolve the active workspace root + cloud provider, and run a callback inside
 * the unified status-bar / error-dialog wrapper.
 *
 * Side-effects on entry / exit (status bar spinner, tree refresh, file
 * decoration refresh, active editor context update) are preserved verbatim.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import { ensureProvider } from "../commands/_providerFactory.js";
import { pickRoot } from "../commands/_shared.js";
import type { RunWithEngineFn } from "../commands/registerWorkspaceLifecycle.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import { refreshActiveEditorSyncContext } from "../ui/editorSyncContext.js";
import { verboseLog } from "../utils/log.js";

export interface RunWithEngineDeps {
  registry: ProviderRegistry;
  globalConfig: GlobalConfigManager;
  getEncKey: () => Promise<Buffer | null>;
  statusBar: SyncStatusBarController;
  workspacesTree: WorkspacesTreeProvider;
  fileDecorations: SyncFileDecorationController;
  makeEngine: (
    root: string,
    provider: import("../providers/cloudProviderTypes.js").ICloudProvider,
    machineId: string,
    machineName: string,
    encKey?: Buffer | null,
  ) => SyncEngine;
}

export function createRunWithEngine(deps: RunWithEngineDeps): RunWithEngineFn {
  const { registry, globalConfig, getEncKey, statusBar, workspacesTree, fileDecorations, makeEngine } = deps;
  let seq = 0;
  return async (
    fn: (engine: SyncEngine, root: string, gc: GlobalConfigManager) => Promise<void>,
    workspaceRoot?: string,
    options?: { showErrorDialog?: boolean },
  ): Promise<void> => {
    const n = ++seq;
    verboseLog("rwe", `#${String(n)} START fn=${fn.name || "(anon)"}`);
    const root = workspaceRoot ?? pickRoot();
    if (!root) {
      await vscode.window.showErrorMessage("VSCodeSync: откройте папку.");
      return;
    }
    const provider = await ensureProvider(registry, globalConfig);
    if (!provider) {
      return;
    }
    const cfg = await globalConfig.load();
    const encKey = await getEncKey();
    const engine = makeEngine(root, provider, cfg.machineId, cfg.machineName, encKey);
    statusBar.setSyncing(true);
    let failure: unknown;
    try {
      await fn(engine, root, globalConfig);
    } catch (e: unknown) {
      failure = e;
    } finally {
      // Refresh runs before any notification is shown. Previously the error
      // branch awaited `showErrorMessage`, whose promise settles only when the
      // user dismisses the toast — and a toast carrying a button does not
      // self-dismiss, it parks in the notification centre. Until the user
      // clicked, this `finally` never ran: the status bar kept claiming
      // "Синхронизация…", the tree and decorations stayed stale. That is the
      // wrapper around all 167 commands.
      verboseLog("rwe", `#${String(n)} finally`);
      statusBar.setSyncing(false);
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }

    if (failure === undefined) return;
    if (options?.showErrorDialog === false) throw toError(failure);
    // Fire-and-forget: the dialog only offers a follow-up action, so the
    // command promise must not hang on the user reading it.
    void reportEngineFailure(failure, globalConfig);
  };
}

/** Normalise anything a rejected promise may carry into a real `Error`. */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (typeof value === "number" || typeof value === "boolean") return new Error(String(value));
  if (value === undefined || value === null) return new Error("Unknown error");
  return new Error(JSON.stringify(value));
}

/** Surface a failed engine run. Never awaited by the caller — see `finally` above. */
async function reportEngineFailure(
  failure: unknown,
  globalConfig: GlobalConfigManager,
): Promise<void> {
  if (failure instanceof ProviderError && failure.code === "UNAUTHORIZED") {
    const gc = await globalConfig.load();
    const providerName = gc.activeProvider ?? "провайдер";
    const choice = await vscode.window.showErrorMessage(
      `VSCodeSync: сессия ${providerName} истекла или недействительна. Необходима повторная авторизация.`,
      "Войти снова",
    );
    if (choice === "Войти снова") {
      await vscode.commands.executeCommand("vscodesync.setActiveProvider");
    }
    return;
  }
  const msg = failure instanceof Error ? failure.message : String(failure);
  await vscode.window.showErrorMessage(`VSCodeSync: ${msg}`);
}
