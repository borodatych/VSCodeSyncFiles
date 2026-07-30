import * as vscode from "vscode";
import { GlobalConfigManager } from "./core/globalConfigManager.js";
import { initLog } from "./utils/logVscode.js";
import type { ICloudProvider } from "./providers/cloudProviderTypes.js";
import { readEncryptionKey } from "./core/encryptionKey.js";
import { disposeAllGlobalQueues } from "./core/requestQueue.js";
import { WorkspaceConfigManager } from "./core/workspaceConfigManager.js";
import type { ProviderType } from "./core/types.js";
import { SyncStatusBarController } from "./ui/statusBar.js";
import { registerAutoSyncModeStatusBar } from "./ui/autoSyncModeStatusBar.js";
import { WorkspacesTreeProvider, type SyncTreeElement } from "./ui/workspacesTree.js";
import { SyncFileDecorationController } from "./ui/fileDecorations.js";
import { registerActiveEditorSyncContext, refreshActiveEditorSyncContext } from "./ui/editorSyncContext.js";
import { registerQuickTransferFeatures } from "./ui/quickTransferUi.js";
import { registerPlannedPaletteCommands } from "./ui/plannedPaletteCommands.js";
import { registerVscodeSyncTaskProvider } from "./ui/vscodeSyncTaskProvider.js";
import { SyncScheduleDeferredStore } from "./core/syncScheduleDeferredStore.js";
import { SyncOfflineQueueStore } from "./core/syncOfflineQueueStore.js";
import { startDigestTimer } from "./ui/notificationService.js";
import { registerGitBranchWorkspaceActivation } from "./ui/gitBranchWorkspaceActivation.js";
import { syncSessionPause } from "./core/syncSessionPause.js";
import { disposeWorkspaceInstanceLock } from "./core/workspaceInstanceLock.js";
import { registerVsCodeSyncTelemetry } from "./telemetry/extensionTelemetry.js";
import { registerProviderSetupGuide } from "./ui/providerSetupGuide.js";
import { registerCommandCenter } from "./ui/commandCenter.js";
import { registerSettingsPanel } from "./ui/settingsPanel.js";
import { scheduleAchievementsWarmup } from "./ui/achievementsService.js";
import { registerSmartFeaturesCommands } from "./commands/registerSmartFeatures.js";
import { registerSmartFeaturesEngineCommands } from "./commands/registerSmartFeaturesEngine.js";
import { registerHashMigrationCommands } from "./commands/registerHashMigration.js";
import { registerOAuthDeviceCodeCommand } from "./commands/registerOAuthDeviceCode.js"; import { resolveDeviceCodeProviders } from "./startup/resolveDeviceCodeProviders.js"; import { registerTemplateMarketplace } from "./commands/registerTemplateMarketplace.js";
import { registerPrefetchCommand } from "./commands/registerPrefetchCommand.js";
import { registerProviders } from "./startup/registerProviders.js";
import { registerConfigChangeListeners } from "./startup/registerConfigChangeListeners.js";
import { restoreWorkspacesTreeFilters } from "./startup/restoreWorkspacesTreeFilters.js";
import { createWorkspaceInstanceLockRefresher } from "./startup/createWorkspaceInstanceLockRefresher.js";
import { createSyncOutputChannels } from "./startup/createSyncOutputChannels.js";
import { unpausePersistedSync } from "./startup/unpausePersistedSync.js";
import { migrateAiMergeFlag } from "./startup/migrateAiMergeFlag.js";
import { registerPanelCommands } from "./commands/registerPanels.js";
import { registerActivitySearchCommands } from "./commands/registerActivitySearches.js";
import { registerProviderSignInCommands } from "./commands/registerProviderSignIn.js";
import { registerWorkspaceLifecycleCommands } from "./commands/registerWorkspaceLifecycle.js";
import { registerViewManagementCommands } from "./commands/registerViewManagement.js";
import { registerSettingsCommands } from "./commands/registerSettings.js";
import { registerWorkspaceTreeContextCommands } from "./commands/registerWorkspaceTreeContext.js";
import { registerFileTreeContextCommands } from "./commands/registerFileTreeContext.js";
import { registerConflictsCommands } from "./commands/registerConflicts.js";
import { registerFileOperationsCommands } from "./commands/registerFileOperations.js";
import { registerSyncOpsCommands } from "./commands/registerSyncOps.js";
import { registerWorkspaceMgmtCommands } from "./commands/registerWorkspaceMgmt.js";
import { registerHeavyMiscCommands } from "./commands/registerHeavyMisc.js";
import { registerDiagnosticsCommands } from "./commands/registerDiagnostics.js";
import { registerWorkspaceCreateCommands } from "./commands/registerWorkspaceCreate.js";
import { ensureProvider, tryAuthenticatedProvider } from "./commands/_providerFactory.js";
import { resolveFileTargetLoose } from "./commands/_fileTargetHelpers.js";
import { createEngineFactory } from "./startup/_engineFactory.js";
import { registerCoreServices } from "./startup/registerCoreServices.js";
import { createRunWithEngine } from "./startup/_runWithEngine.js";
import { createRunAfterSessionResume } from "./startup/createRunAfterSessionResume.js";
import { registerScheduledSnapshotsWiring } from "./startup/registerScheduledSnapshotsWiring.js";
import { createEngineLogRefs } from "./startup/createEngineLogRefs.js";
import { wireEngineFactoryRefs } from "./startup/wireEngineFactoryRefs.js";
import { registerObservers } from "./startup/registerObservers.js";
import { registerProviderAuthBundle } from "./startup/registerProviderAuthBundle.js";
import { registerSyncMonitors } from "./startup/registerSyncMonitors.js";
import { registerCodeLensProviders } from "./startup/registerCodeLensProviders.js";
import { registerWebhookLifecycles } from "./startup/registerWebhookLifecycles.js";
import { registerScheduledHelpers } from "./startup/registerScheduledHelpers.js";
import { registerFileLifecycleEvents } from "./startup/registerFileLifecycleEvents.js";
import { registerOnboardingFlow } from "./startup/registerOnboardingFlow.js";
import { registerWorkspaceTreeWiring } from "./startup/registerWorkspaceTreeWiring.js";
import { createP2PSessionRegistry } from "./core/p2pSessionRegistry.js"; import { createMirrorRegistry, mirrorPushedFile } from "./ui/p2pFileTransferMirror.js";
import { createP2PStatusBarItem } from "./ui/p2pStatusBar.js";
import { registerP2PSessionCommands } from "./commands/registerP2PSession.js";
import { registerPasskeyCommands } from "./ui/passkeyCommands.js";
import { registerSarifExportCommand } from "./commands/registerSarifExport.js";
import { registerReadmeAutoRender } from "./commands/registerReadmeAutoRender.js";
import { registerEncryptedBundleExport } from "./commands/registerEncryptedBundleExport.js";
import { registerAnalyticsPanel } from "./commands/registerAnalyticsPanel.js";
import { ActivityAlertMonitor } from "./ui/activityAlertMonitor.js";
import { registerPhase21Bootstrap } from "./startup/registerPhase21Bootstrap.js";

const CFG_SECTION = "vscodesync";

/** When the SyncTimelineProvider is created, this fires on new sync events. */
let timelineFireChangeRef: (() => void) | undefined;


function roots(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

async function updateWorkspacesTreeBadge(tv: vscode.TreeView<SyncTreeElement>): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    tv.badge = undefined;
    return;
  }
  try {
    let n = 0;
    for (const folder of folders) {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      n += wc.files.filter((f) => f.syncStatus === "conflict").length;
    }
    tv.badge =
      n > 0
        ? { value: n, tooltip: n === 1 ? "1 конфликт синхронизации" : `Конфликтов: ${String(n)}` }
        : undefined;
  } catch {
    tv.badge = undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  migrateAiMergeFlag();

  const globalDir = GlobalConfigManager.resolveDefaultConfigDir();
  const globalConfig = new GlobalConfigManager(globalDir, context.secrets);
  const scheduleDeferredStore = new SyncScheduleDeferredStore(globalConfig.getStorageDir());
  const offlineQueueStore = new SyncOfflineQueueStore(globalConfig.getStorageDir());

  const p2pSessionRegistry = createP2PSessionRegistry(); const p2pMirrorRegistry = createMirrorRegistry();
  createP2PStatusBarItem(context, p2pSessionRegistry);
  context.subscriptions.push(
    ...registerPasskeyCommands({ context }),
    ...registerSarifExportCommand({ storageDir: globalConfig.getStorageDir() }),
    ...registerReadmeAutoRender({ context }),
    ...registerEncryptedBundleExport(),
    ...registerAnalyticsPanel({ context }),
  );

  registerVsCodeSyncTelemetry(context, globalConfig, CFG_SECTION);
  registerProviderSetupGuide(context);
  registerCommandCenter(context);
  registerSettingsPanel(context);

  const activityAlertMonitor = new ActivityAlertMonitor(context);
  context.subscriptions.push(activityAlertMonitor);

  const getEncKey = async (): Promise<Buffer | null> => {
    const encOn = vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("encryption", false);
    if (!encOn) return null;
    return readEncryptionKey(context.secrets);
  };

  const engineFactory = createEngineFactory({ getEncKey });

  registerCoreServices(context, engineFactory, globalConfig);
  const { makeEngine, notifiedConflictKeys, profileBuffer } = engineFactory;

  const { logSyncActivity, logSyncStatsTransfer, logSyncCompression } = createEngineLogRefs({
    globalConfig,
    activityAlertMonitor,
    fireTimelineChange: () => { timelineFireChangeRef?.(); },
  });

  unpausePersistedSync(globalConfig, syncSessionPause);

  const registry = registerProviders({ context, globalConfig });

  const fileDecorations = new SyncFileDecorationController();
  context.subscriptions.push(fileDecorations);
  const { syncPreviewChannel, healthCheckChannel } = createSyncOutputChannels(context);
  const fileDecorationRegistration = vscode.window.registerFileDecorationProvider(fileDecorations);

  registerCodeLensProviders({ context, globalConfig });

  // Achievements warmup (5 s after activate so we don't pile onto startup)
  // and the smart-features command bundle (showAchievements,
  // installWorkspaceTemplate) are wired separately — see
  // src/commands/registerSmartFeatures.ts for the bundle contract.
  context.subscriptions.push(
    scheduleAchievementsWarmup(context, globalConfig.getStorageDir()),
    ...registerSmartFeaturesCommands({
      context,
      storageDir: globalConfig.getStorageDir(),
    }),
  );

  context.subscriptions.push(fileDecorationRegistration);
  context.subscriptions.push(registerConfigChangeListeners({ context, fileDecorations }));

  const statusBar = new SyncStatusBarController({
    globalConfig,
    scheduleDeferredStore,
    offlineQueue: offlineQueueStore,
    onSyncingChange: (syncing) => {
      fileDecorations.setSyncInProgress(syncing);
    },
  });
  context.subscriptions.push(statusBar);
  registerAutoSyncModeStatusBar(context);

  const lockRefresher = createWorkspaceInstanceLockRefresher({ globalConfig, statusBar, roots });
  const refreshWorkspaceInstanceLock = lockRefresher.refresh;
  context.subscriptions.push(...lockRefresher.subscriptions);

  registerActiveEditorSyncContext(context);

  const workspacesTree = new WorkspacesTreeProvider();
  context.subscriptions.push(workspacesTree);

  restoreWorkspacesTreeFilters(context, workspacesTree);
  void globalConfig.load().then((gc) => {
    workspacesTree.setLocalMachineIdentity(gc.machineId, gc.machineName);
    workspacesTree.setActiveCloudProvider(gc.activeProvider);
  });

  const onboardingCloudDeps = {
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    onActiveProviderChanged: (t: ProviderType) => {
      workspacesTree.setActiveCloudProvider(t);
    },
  };

  const runWithEngine = createRunWithEngine({
    registry,
    globalConfig,
    statusBar,
    workspacesTree,
    fileDecorations,
    makeEngine,
  });

  wireEngineFactoryRefs({
    engineFactory,
    logRefs: { logSyncActivity, logSyncStatsTransfer, logSyncCompression },
    runWithEngine,
    statusBar,
    workspacesTree,
    mirrorPushedFile: (wId, rel, pt) => { mirrorPushedFile(p2pMirrorRegistry, wId, rel, pt); },
  });

  registerVscodeSyncTaskProvider(context, {
    runWithEngine,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
  });

  const webhookLifecycles = registerWebhookLifecycles({
    context,
    globalConfig,
    registry,
    statusBar,
    workspacesTree,
    fileDecorations,
    offlineQueueStore,
    makeEngine,
  });
  const refreshCloudWebhooks = webhookLifecycles.refresh;

  const gitBranchActivationDeps = {
    globalConfig,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    makeEngine,
    refreshUi: async () => {
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
      await statusBar.refresh();
    },
  };

  registerGitBranchWorkspaceActivation(context, gitBranchActivationDeps);

  registerSyncMonitors({
    context,
    globalConfig,
    registry,
    statusBar,
    workspacesTree,
    fileDecorations,
    scheduleDeferredStore,
    offlineQueueStore,
    makeEngine,
  });

  const { treeView } = registerWorkspaceTreeWiring({
    context,
    globalConfig,
    registry,
    workspacesTree,
    runWithEngine,
    makeEngine,
    updateBadge: updateWorkspacesTreeBadge,
  });

  context.subscriptions.push(
    ...registerViewManagementCommands({ context, treeView, workspacesTree, statusBar }),
  );

  context.subscriptions.push(

    ...registerSettingsCommands({ globalConfig, registry, statusBar }),
  );


  const providerAuthFlows = registerProviderAuthBundle({
    context,
    globalConfig,
    registry,
    workspacesTree,
    statusBar,
    fileDecorations,
    refreshCloudWebhooks,
    makeEngine,
  });

  context.subscriptions.push(
    ...registerWorkspaceTreeContextCommands({ context, treeView, workspacesTree, syncPreviewChannel, runWithEngine }),

    ...registerWorkspaceMgmtCommands({
      globalConfig,
      workspacesTree,
      statusBar,
      runWithEngine,
    }),

    ...registerWorkspaceLifecycleCommands({
      workspacesTree,
      statusBar,
      fileDecorations,
      syncPreviewChannel,
      refreshActiveEditor: () => { void refreshActiveEditorSyncContext(); },
      runWithEngine,
    }),

    ...registerFileTreeContextCommands({
      globalConfig,
      workspacesTree,
      statusBar,
      fileDecorations,
      registry,
      refreshActiveEditor: () => { void refreshActiveEditorSyncContext(); },
      runWithEngine,
      logSyncActivity,
    }),
  );

  context.subscriptions.push(
    ...registerConflictsCommands({
      globalConfig,
      workspacesTree,
      statusBar,
      fileDecorations,
      refreshActiveEditor: () => { void refreshActiveEditorSyncContext(); },
      runWithEngine,
      logSyncActivity,
      notifiedConflictKeys,
    }),
  );

  context.subscriptions.push(
    ...registerWorkspaceCreateCommands({ context, runWithEngine }),

    ...registerSyncOpsCommands({ runWithEngine }),

    ...registerDiagnosticsCommands({
      globalConfig,
      registry,
      offlineQueueStore,
      scheduleDeferredStore,
      healthCheckChannel,
      refreshWorkspaceInstanceLock,
      tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
      makeEngine,
      roots, profileBuffer,
    }),


    ...registerProviderSignInCommands({
      context,
      globalConfig,
      workspacesTree,
      statusBar,
      fileDecorations,
      registry,
      refreshActiveEditor: () => { void refreshActiveEditorSyncContext(); },
      refreshCloudWebhooks,
      signIn: providerAuthFlows,
    }),

    ...registerHeavyMiscCommands({
      globalConfig,
      workspacesTree,
      statusBar,
      syncPreviewChannel,
      runWithEngine,
      onboardingCloudDeps,
      gitBranchActivationDeps,
    }),
  );

  registerFileLifecycleEvents({ context, runWithEngine });
  const tap = () => tryAuthenticatedProvider(registry);
  const makeEngineForRoot = async (root: string, provider: ICloudProvider) => { const gc = await globalConfig.load(); return makeEngine(root, provider, gc.machineId, gc.machineName, "user"); };
  context.subscriptions.push(...registerSmartFeaturesEngineCommands({ context, globalConfig, tryAuthenticatedProvider: tap }), ...registerHashMigrationCommands({ context, tryAuthenticatedProvider: tap, makeEngineForRoot }), ...registerP2PSessionCommands({ context, registry: p2pSessionRegistry, tryAuthenticatedProvider: tap, globalConfig, mirrorRegistry: p2pMirrorRegistry, logSyncActivity }), ...registerOAuthDeviceCodeCommand({ context, resolveProviders: () => resolveDeviceCodeProviders(context) }), ...registerTemplateMarketplace(), ...registerPrefetchCommand());

  registerPlannedPaletteCommands(context, {
    globalConfig,
    makeEngine,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    workspacesTree,
    secrets: context.secrets,
    refreshAfterLocalConfigChange: async () => {
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    },
    runAfterSessionResume: createRunAfterSessionResume({
      globalConfig,
      registry,
      makeEngine,
      syncPreviewChannel,
      statusBar,
      workspacesTree,
      fileDecorations,
      offlineQueueStore,
    }),
  });

  registerQuickTransferFeatures(context, {
    globalConfig,
    ensureProvider: () => ensureProvider(registry, globalConfig),
    offlineQueue: offlineQueueStore,
    resolveFileTargetLoose: (arg) => resolveFileTargetLoose(globalConfig, arg),
    refreshUi: async () => {
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    },
  });

  registerScheduledHelpers({
    context,
    globalConfig,
    registry,
    statusBar,
    workspacesTree,
    fileDecorations,
    scheduleDeferredStore,
    makeEngine,
  });

  startDigestTimer(context);

  const onboardingFlow = registerOnboardingFlow({
    context,
    globalConfig,
    registry,
    statusBar,
    workspacesTree,
    offlineQueueStore,
    scheduleDeferredStore,
    makeEngine,
    workspaceFolders: roots,
  });
  timelineFireChangeRef = onboardingFlow.fireTimelineChange;

  // Activity-feed saved searches and panel webviews — registered via per-area
  // command modules (см. v2.6 декомпозицию `extension.ts`).
  context.subscriptions.push(
    ...registerActivitySearchCommands({ context }),
    ...registerPanelCommands({ context, storageDir: globalConfig.getStorageDir() }),
    ...registerFileOperationsCommands({
      context,
      globalConfig,
      offlineQueueStore,
      registry,
      runWithEngine,
    }),
  );

  registerObservers({ context, globalConfig, registry });
  registerScheduledSnapshotsWiring({ context, globalConfig, registry });

  // v0.15 Phase 21 — wire pure helpers added in v0.8–v0.14 to user-visible commands.
  registerPhase21Bootstrap({
    context, globalConfig, registry, runWithEngine, makeEngine, profileBuffer,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
  });
}

export function deactivate(): void {
  void disposeWorkspaceInstanceLock();
  disposeAllGlobalQueues();
}
