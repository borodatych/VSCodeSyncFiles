/**
 * Webhook lifecycle wiring — extracted from `extension.ts` (Phase 0 / v2.11.3).
 *
 * Boots the OneDrive + Google Drive lifecycle subsystems, sharing the
 * `VSCodeSync · Webhooks` OutputChannel and a unified `QuietFullSyncAllFoldersDeps`.
 * Returns the lifecycle handles + a `refresh()` helper used by the OAuth
 * callbacks in providerAuthFlows to re-evaluate webhooks after sign-in.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { tryAuthenticatedProvider } from "../commands/_providerFactory.js";
import { registerOneDriveWebhookLifecycle } from "../ui/oneDriveWebhookLifecycle.js";
import { registerGoogleDriveWebhookLifecycle } from "../ui/googleDriveWebhookLifecycle.js";
import type { QuietFullSyncAllFoldersDeps } from "../ui/quietFullSyncAllFolders.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import type { SyncEngine } from "../core/syncEngine.js";
import { refreshActiveEditorSyncContext } from "../ui/editorSyncContext.js";

export interface WebhookLifecyclesDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  statusBar: SyncStatusBarController;
  workspacesTree: WorkspacesTreeProvider;
  fileDecorations: SyncFileDecorationController;
  offlineQueueStore: SyncOfflineQueueStore;
  makeEngine: (
    root: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
  ) => SyncEngine;
}

export interface WebhookLifecyclesHandle {
  readonly refresh: () => void;
  readonly webhookSyncDeps: QuietFullSyncAllFoldersDeps;
}

export function registerWebhookLifecycles(deps: WebhookLifecyclesDeps): WebhookLifecyclesHandle {
  const {
    context,
    globalConfig,
    registry,
    statusBar,
    workspacesTree,
    fileDecorations,
    offlineQueueStore,
    makeEngine,
  } = deps;

  const webhooksOut = vscode.window.createOutputChannel("VSCodeSync · Webhooks");
  context.subscriptions.push(webhooksOut);

  const webhookSyncDeps: QuietFullSyncAllFoldersDeps = {
    globalConfig,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    makeEngine: (root, provider, machineId, machineName) =>
      makeEngine(root, provider, machineId, machineName),
    statusBar,
    offlineQueue: offlineQueueStore,
    refreshUi: () => {
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    },
  };

  const oneDriveWebhookLifecycle = registerOneDriveWebhookLifecycle(
    context,
    globalConfig,
    context.secrets,
    webhookSyncDeps,
    webhooksOut,
  );
  const googleDriveWebhookLifecycle = registerGoogleDriveWebhookLifecycle(
    context,
    globalConfig,
    context.secrets,
    webhookSyncDeps,
    webhooksOut,
  );

  return {
    refresh(): void {
      void oneDriveWebhookLifecycle.refresh();
      void googleDriveWebhookLifecycle.refresh();
    },
    webhookSyncDeps,
  };
}
