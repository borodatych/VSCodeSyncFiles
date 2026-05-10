/**
 * v2.6.7 — provider OAuth flows + migration command bundle, extracted from
 * `extension.ts`. Wires the four sign-in closures (OneDrive / Google
 * Drive / Dropbox / Yandex Disk) and the provider migration command in
 * one shot, returning the flows handle so downstream sign-in command
 * bundles can route through the same closures.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import { refreshActiveEditorSyncContext } from "../ui/editorSyncContext.js";
import { createProviderAuthFlows } from "../auth/providerAuthFlows.js";
import { registerProviderMigrationCommand } from "../ui/providerMigrationUi.js";

export interface ProviderAuthBundleDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
  fileDecorations: SyncFileDecorationController;
  refreshCloudWebhooks: () => void;
  makeEngine: (root: string, provider: ICloudProvider, machineId: string, machineName: string) => SyncEngine;
}

export type ProviderAuthFlowsHandle = ReturnType<typeof createProviderAuthFlows>;

export function registerProviderAuthBundle(deps: ProviderAuthBundleDeps): ProviderAuthFlowsHandle {
  const flows = createProviderAuthFlows({
    context: deps.context,
    globalConfig: deps.globalConfig,
    workspacesTree: deps.workspacesTree,
    statusBar: deps.statusBar,
    fileDecorations: deps.fileDecorations,
    refreshActiveEditor: () => { void refreshActiveEditorSyncContext(); },
    refreshCloudWebhooks: deps.refreshCloudWebhooks,
  });
  registerProviderMigrationCommand(deps.context, {
    registry: deps.registry,
    globalConfig: deps.globalConfig,
    workspacesTree: deps.workspacesTree,
    makeEngine: deps.makeEngine,
    signInOneDrive: () => flows.oneDrive(true),
    signInGoogleDrive: () => flows.googleDrive(true),
    signInDropbox: () => flows.dropbox(true),
    signInYandexDisk: () => flows.yandexDisk(true),
    refreshUi: async () => {
      await deps.statusBar.refresh();
      deps.workspacesTree.refresh();
      deps.fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
      deps.refreshCloudWebhooks();
    },
  });
  return flows;
}
