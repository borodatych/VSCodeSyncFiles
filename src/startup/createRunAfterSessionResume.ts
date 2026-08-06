/**
 * v2.6.7 — extracted `runAfterSessionResume` closure from `extension.ts`.
 *
 * Drives the post-pause "preview + offer to resume" flow: load workspaces
 * for every folder, summarise pending work, and prompt the user to either
 * trigger a quiet full sync or postpone. Pure orchestration — no module
 * state.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import { tryAuthenticatedProvider } from "../commands/_providerFactory.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import {
  decideResumeAction,
  formatResumeSummaryMessage,
  summariseResumePlans,
} from "../core/sessionResumeSummary.js";
import { writeSyncPreviewOutput } from "../ui/syncPreviewUi.js";
import { runQuietFullSyncAllFolders } from "../ui/quietFullSyncAllFolders.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { refreshActiveEditorSyncContext } from "../ui/editorSyncContext.js";

export interface RunAfterSessionResumeDeps {
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  makeEngine: (root: string, provider: ICloudProvider, machineId: string, machineName: string, trigger: SyncTrigger) => SyncEngine;
  syncPreviewChannel: vscode.OutputChannel;
  statusBar: SyncStatusBarController;
  workspacesTree: WorkspacesTreeProvider;
  fileDecorations: SyncFileDecorationController;
  offlineQueueStore: SyncOfflineQueueStore;
}

export function createRunAfterSessionResume(deps: RunAfterSessionResumeDeps): () => Promise<void> {
  const {
    globalConfig,
    registry,
    makeEngine,
    syncPreviewChannel,
    statusBar,
    workspacesTree,
    fileDecorations,
    offlineQueueStore,
  } = deps;

  return async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const providerOrNull = await tryAuthenticatedProvider(registry);
    const action = decideResumeAction({ hasProvider: providerOrNull !== null, hasActiveRoot: false });
    if (action === "abort_no_provider") {
      await vscode.window.showWarningMessage(
        "VSCodeSync: провайдер не авторизован — выполните Pull/Push вручную после снятия паузы.",
      );
      syncSessionPause.clearPendingDocs();
      await statusBar.refresh();
      return;
    }
    const provider = providerOrNull!;
    const gcfg = await globalConfig.load();
    const allPlans: Awaited<ReturnType<SyncEngine["previewSyncPlan"]>> = [];
    let anyRoot = false;
    for (const folder of folders) {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      if (wc.activeWorkspaces.length === 0) {
        continue;
      }
      anyRoot = true;
      const engine = makeEngine(folder.uri.fsPath, provider, gcfg.machineId, gcfg.machineName, "auto");
      try {
        const part = await engine.previewSyncPlan();
        allPlans.push(...part);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`VSCodeSync: preview после паузы — ${msg}`);
        return;
      }
    }
    if (!anyRoot) {
      syncSessionPause.clearPendingDocs();
      await statusBar.refresh();
      return;
    }
    writeSyncPreviewOutput(syncPreviewChannel, allPlans);
    syncPreviewChannel.show(true);
    const totals = summariseResumePlans(allPlans);
    const choice = await vscode.window.showWarningMessage(
      formatResumeSummaryMessage(totals),
      { modal: true },
      "Синхронизировать",
      "Позже",
    );
    if (choice === "Синхронизировать") {
      await runQuietFullSyncAllFolders({
        globalConfig,
        tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
        makeEngine,
        statusBar,
        offlineQueue: offlineQueueStore,
        // Reached only from the modal above, after the user chose
        // "Синхронизировать" over the preview of what would move.
        trigger: "user",
        refreshUi: () => {
          workspacesTree.refresh();
          fileDecorations.refresh();
          void refreshActiveEditorSyncContext();
        },
      });
    }
    syncSessionPause.clearPendingDocs();
    await statusBar.refresh();
  };
}
