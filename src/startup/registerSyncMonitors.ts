/**
 * v2.6.7 — sync monitors bundle, extracted from `extension.ts`.
 *
 * Composes 5 passive monitors that share the same `(globalConfig,
 * tryAuthenticatedProvider, makeEngine, statusBar, refreshUi)` shape:
 *   - sync trigger manager (file-save → push)
 *   - watch-mode poller (interval → pull)
 *   - auto-pause monitor (battery / metered / focus → pause hint)
 *   - offline recovery monitor (network online → drain queue)
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { tryAuthenticatedProvider } from "../commands/_providerFactory.js";
import { refreshActiveEditorSyncContext } from "../ui/editorSyncContext.js";
import { registerSyncTriggerManager } from "../ui/syncTriggerManager.js";
import { registerWatchModePoller } from "../ui/watchModePoller.js";
import { registerAutoPauseMonitor } from "../ui/syncAutoPauseMonitor.js";
import { registerOfflineRecoveryMonitor } from "../ui/syncOfflineRecoveryMonitor.js";

export interface SyncMonitorsDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  statusBar: SyncStatusBarController;
  workspacesTree: WorkspacesTreeProvider;
  fileDecorations: SyncFileDecorationController;
  offlineQueueStore: SyncOfflineQueueStore;
  makeEngine: (root: string, provider: ICloudProvider, machineId: string, machineName: string, trigger: SyncTrigger) => SyncEngine;
}

export function registerSyncMonitors(deps: SyncMonitorsDeps): void {
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

  const tap = (): Promise<ICloudProvider | null> => tryAuthenticatedProvider(registry);
  const refreshUiWithStatus = (): void => {
    workspacesTree.refresh();
    fileDecorations.refresh();
    void refreshActiveEditorSyncContext();
    void statusBar.refresh();
  };
  const refreshUiPlain = (): void => {
    workspacesTree.refresh();
    fileDecorations.refresh();
    void refreshActiveEditorSyncContext();
  };

  registerSyncTriggerManager(context, {
    globalConfig,
    tryAuthenticatedProvider: tap,
    makeEngine,
    statusBar,
    offlineQueue: offlineQueueStore,
    refreshUi: refreshUiWithStatus,
  });

  registerWatchModePoller(context, {
    globalConfig,
    tryAuthenticatedProvider: tap,
    makeEngine,
    statusBar,
    offlineQueue: offlineQueueStore,
    refreshUi: refreshUiPlain,
    trigger: "auto",
  });

  registerAutoPauseMonitor(context);

  registerOfflineRecoveryMonitor(context, {
    offlineQueue: offlineQueueStore,
    globalConfig,
    tryAuthenticatedProvider: tap,
    makeEngine,
    statusBar,
    refreshUi: refreshUiWithStatus,
    trigger: "auto",
  });
}
