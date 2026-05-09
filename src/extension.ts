import * as vscode from "vscode";
import { GlobalConfigManager } from "./core/globalConfigManager.js";
import { initLog } from "./utils/logVscode.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { ICloudProvider } from "./providers/cloudProviderTypes.js";
import { OneDriveProvider } from "./providers/onedrive/onedriveProvider.js";
import { GdriveProvider } from "./providers/gdrive/gdriveProvider.js";
import { DropboxProvider } from "./providers/dropbox/dropboxProvider.js";
import { YandexDiskProvider } from "./providers/yandex/yandexDiskProvider.js";
import { appendActivityEvent } from "./core/activityLog.js";
import { recordCompressionSaving, recordTransferBytes } from "./core/syncStatsStore.js";
import { SyncEngine } from "./core/syncEngine.js";
import { readEncryptionKey, ensureEncryptionKey } from "./core/encryptionKey.js";
import { disposeAllGlobalQueues } from "./core/requestQueue.js";
import { WorkspaceConfigManager } from "./core/workspaceConfigManager.js";
import type { ProviderType } from "./core/types.js";
import { SyncStatusBarController } from "./ui/statusBar.js";
import { WorkspacesTreeProvider, type SyncTreeElement } from "./ui/workspacesTree.js";
import { SyncFileDecorationController } from "./ui/fileDecorations.js";
import { writeSyncPreviewOutput } from "./ui/syncPreviewUi.js";
import { registerActiveEditorSyncContext, refreshActiveEditorSyncContext } from "./ui/editorSyncContext.js";
import { registerProviderMigrationCommand } from "./ui/providerMigrationUi.js";
import { registerQuickTransferFeatures } from "./ui/quickTransferUi.js";
import { registerPlannedPaletteCommands } from "./ui/plannedPaletteCommands.js";
import { registerVscodeSyncTaskProvider } from "./ui/vscodeSyncTaskProvider.js";
import { SyncScheduleDeferredStore } from "./core/syncScheduleDeferredStore.js";
import { SyncOfflineQueueStore } from "./core/syncOfflineQueueStore.js";
import { registerAutoPauseMonitor } from "./ui/syncAutoPauseMonitor.js";
import { registerSyncScheduleTransition } from "./ui/syncScheduleTransition.js";
import { registerSyncTriggerManager } from "./ui/syncTriggerManager.js";
import { startDigestTimer, recordDigestPush, recordDigestPull, recordDigestConflict } from "./ui/notificationService.js";
import { registerOfflineRecoveryMonitor } from "./ui/syncOfflineRecoveryMonitor.js";
import { runQuietFullSyncAllFolders } from "./ui/quietFullSyncAllFolders.js";
import { registerWatchModePoller } from "./ui/watchModePoller.js";
import { registerGitBranchWorkspaceActivation } from "./ui/gitBranchWorkspaceActivation.js";
import { syncSessionPause } from "./core/syncSessionPause.js";
import {
  disposeWorkspaceInstanceLock,
  scheduleWorkspaceInstanceLockRefresh,
} from "./core/workspaceInstanceLock.js";
import { registerVsCodeSyncTelemetry } from "./telemetry/extensionTelemetry.js";
import { registerProviderSetupGuide } from "./ui/providerSetupGuide.js";
import { registerCommandCenter } from "./ui/commandCenter.js";
import { registerSettingsPanel } from "./ui/settingsPanel.js";
import { registerScheduledSnapshots } from "./ui/scheduledSnapshots.js";
import { scheduleAchievementsWarmup } from "./ui/achievementsService.js";
import { registerSmartFeaturesCommands } from "./commands/registerSmartFeatures.js";
import { registerSmartFeaturesEngineCommands } from "./commands/registerSmartFeaturesEngine.js";
import { registerHashMigrationCommands } from "./commands/registerHashMigration.js";
import { registerOAuthDeviceCodeCommand } from "./commands/registerOAuthDeviceCode.js"; import { resolveDeviceCodeProviders } from "./startup/resolveDeviceCodeProviders.js";
import { SmartConflictPredictionService } from "./ui/smartConflictPredictionService.js";
import { registerPresenceHeartbeat } from "./ui/presenceHeartbeat.js";
import { registerCrossCloudBackup } from "./ui/crossCloudBackup.js";
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
import { createProviderAuthFlows } from "./auth/providerAuthFlows.js";
import { resolveFileTargetLoose } from "./commands/_fileTargetHelpers.js";
import { createEngineFactory } from "./startup/_engineFactory.js";
import { createRunWithEngine } from "./startup/_runWithEngine.js";
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
import {
  WORKSPACES_NOTE_FILTER_KEY,
  WORKSPACES_TAG_FILTERS_KEY,
  WORKSPACES_SHOW_ARCHIVED_KEY,
} from "./ui/workspacesTreeFilterState.js";
import { ActivityAlertMonitor } from "./ui/activityAlertMonitor.js";

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
  );

  registerVsCodeSyncTelemetry(context, globalConfig, CFG_SECTION);
  registerProviderSetupGuide(context);
  registerCommandCenter(context);
  registerSettingsPanel(context);

  const activityAlertMonitor = new ActivityAlertMonitor(context);
  context.subscriptions.push(activityAlertMonitor);

  const engineFactory = createEngineFactory();
  const { makeEngine, notifiedConflictKeys } = engineFactory;

  const logSyncActivity: NonNullable<
    Parameters<typeof engineFactory.setRefs>[0]["logSyncActivity"]
  > = (ev) => {
    const retention = vscode.workspace.getConfiguration(CFG_SECTION).get<number>("activityRetentionDays", 90);
    void appendActivityEvent(globalConfig.getStorageDir(), ev, retention);
    timelineFireChangeRef?.();
    activityAlertMonitor.notify(ev);
    if (ev.kind === "push") recordDigestPush(1, ev.machineName);
    else if (ev.kind === "pull") recordDigestPull(1, ev.machineName);
    else if (ev.kind === "conflict") recordDigestConflict(ev.relPath);
    // Feed into the sync-replay recorder when an active session is running.
    void (async () => {
      try {
        const { feedActivity } = await import("./ui/syncReplayRecorderState.js");
        feedActivity(ev);
      } catch { /* recorder is best-effort; silent */ }
    })();
  };
  const logSyncStatsTransfer: NonNullable<
    Parameters<typeof engineFactory.setRefs>[0]["logSyncStatsTransfer"]
  > = (ev) => {
    void recordTransferBytes(globalConfig.getStorageDir(), ev);
  };
  const logSyncCompression: NonNullable<
    Parameters<typeof engineFactory.setRefs>[0]["logSyncCompression"]
  > = (saved) => {
    void recordCompressionSaving(globalConfig.getStorageDir(), saved);
  };

  void (async () => {
    const g = await globalConfig.load();
    if (g.syncPaused) {
      syncSessionPause.setPaused(true);
      await globalConfig.set("syncPaused", false);
      await globalConfig.save();
    }
  })();

  const registry = new ProviderRegistry(() => globalConfig.load());
  registry.register("onedrive", () => new OneDriveProvider(context.secrets));
  registry.register(
    "gdrive",
    () =>
      new GdriveProvider(context.secrets, () => {
        const raw = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("googleDriveClientId", "");
        return typeof raw === "string" ? raw : "";
      }),
  );
  registry.register(
    "yandex",
    () => {
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const useAppFolder = cfg.get<boolean>("yandexUseAppFolder", false);
      return new YandexDiskProvider(
        context.secrets,
        () => {
          const raw = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("yandexOAuthClientId", "");
          return typeof raw === "string" ? raw : "";
        },
        useAppFolder,
      );
    },
  );
  registry.register(
    "dropbox",
    () =>
      new DropboxProvider(context.secrets, () => {
        const raw = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("dropboxAppKey", "");
        return typeof raw === "string" ? raw : "";
      }),
  );

  const fileDecorations = new SyncFileDecorationController();
  context.subscriptions.push(fileDecorations);
  const syncPreviewChannel = vscode.window.createOutputChannel("VSCodeSync · Preview");
  context.subscriptions.push(syncPreviewChannel);
  const healthCheckChannel = vscode.window.createOutputChannel("VSCodeSync · Health Check");
  context.subscriptions.push(healthCheckChannel);
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

  // Smart Conflict Prediction — status-bar warning when another machine has
  // marked itself as editing the same active file.
  const conflictPredictor = new SmartConflictPredictionService(globalConfig, () => tryAuthenticatedProvider(registry));
  conflictPredictor.start();
  context.subscriptions.push(conflictPredictor);

  context.subscriptions.push(fileDecorationRegistration);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.showFileDecorations") || e.affectsConfiguration("vscodesync.lineEnding")) {
        fileDecorations.refresh();
      }
      if (e.affectsConfiguration("vscodesync.encryption")) {
        const on = vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("encryption", false);
        if (on) {
          void (async () => {
            const existing = await readEncryptionKey(context.secrets);
            if (!existing) {
              await ensureEncryptionKey(context.secrets);
              await vscode.window.showWarningMessage(
                "VSCodeSync: шифрование включено. Ключ AES-256 сгенерирован и сохранён в системный keychain. Сохраните резервную копию через «VSCodeSync: Export Encryption Key».",
                "Экспортировать сейчас",
              ).then(async (choice) => {
                if (choice === "Экспортировать сейчас") {
                  await vscode.commands.executeCommand("vscodesync.exportEncryptionKey");
                }
              });
            }
          })();
        }
      }
      if (e.affectsConfiguration("vscodesync.watchIntervalSeconds")) {
        const sec = vscode.workspace.getConfiguration(CFG_SECTION).get<number>("watchIntervalSeconds", 30);
        if (sec < 30) {
          void vscode.window.showWarningMessage(
            `VSCodeSync: watchIntervalSeconds = ${String(sec)} — рекомендуется ≥ 30 сек. Слишком частый polling может исчерпать лимиты API провайдера.`,
          );
        }
      }
    }),
  );

  const statusBar = new SyncStatusBarController({
    globalConfig,
    scheduleDeferredStore,
    offlineQueue: offlineQueueStore,
    onSyncingChange: (syncing) => {
      fileDecorations.setSyncInProgress(syncing);
    },
  });
  context.subscriptions.push(statusBar);

  const refreshWorkspaceInstanceLock = (): void => {
    scheduleWorkspaceInstanceLockRefresh(
      globalConfig.getStorageDir(),
      roots().map((f) => f.uri.fsPath),
      () => {
        void statusBar.refresh();
      },
    );
  };
  refreshWorkspaceInstanceLock();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshWorkspaceInstanceLock();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        refreshWorkspaceInstanceLock();
      }
    }),
  );

  registerActiveEditorSyncContext(context);

  const workspacesTree = new WorkspacesTreeProvider();
  context.subscriptions.push(workspacesTree);

  const savedNoteFilter = context.globalState.get<string>(WORKSPACES_NOTE_FILTER_KEY) ?? "";
  workspacesTree.setNoteFilter(savedNoteFilter);
  const savedTagFilters = context.globalState.get<unknown>(WORKSPACES_TAG_FILTERS_KEY);
  const tagList: string[] =
    Array.isArray(savedTagFilters) && savedTagFilters.every((x): x is string => typeof x === "string")
      ? savedTagFilters
      : [];
  workspacesTree.setTagFilters(tagList);
  workspacesTree.setShowArchived(context.globalState.get(WORKSPACES_SHOW_ARCHIVED_KEY) === true);
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

  const getEncKey = async (): Promise<Buffer | null> => {
    const encOn = vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("encryption", false);
    if (!encOn) return null;
    return readEncryptionKey(context.secrets);
  };

  const runWithEngine = createRunWithEngine({
    registry,
    globalConfig,
    getEncKey,
    statusBar,
    workspacesTree,
    fileDecorations,
    makeEngine,
  });

  const repushDeletedWorkspace: NonNullable<
    Parameters<typeof engineFactory.setRefs>[0]["repushDeletedWorkspace"]
  > = async (workspaceId, localRoot, savedEntry, savedFiles) => {
    await runWithEngine(async (engine) => {
      await engine.repushWorkspaceToCloud(workspaceId, savedEntry, savedFiles);
      await vscode.window.showInformationMessage(
        `VSCodeSync: workspace «${savedEntry.workspaceNote || workspaceId}» восстановлен на облаке.`,
      );
    }, localRoot);
    workspacesTree.invalidateRemoteCache();
    workspacesTree.refresh();
    await statusBar.refresh();
  };

  engineFactory.setRefs({
    logSyncActivity,
    logSyncStatsTransfer,
    logSyncCompression,
    treeRefresh: () => { workspacesTree.refresh(); },
    repushDeletedWorkspace,
    mirrorPushedFile: (wId, rel, pt) => { mirrorPushedFile(p2pMirrorRegistry, wId, rel, pt); },
  });

  registerVscodeSyncTaskProvider(context, {
    runWithEngine,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
  });

  registerSyncTriggerManager(context, {
    globalConfig,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    makeEngine: (root, provider, machineId, machineName) =>
      makeEngine(root, provider, machineId, machineName),
    statusBar,
    scheduleDeferred: scheduleDeferredStore,
    offlineQueue: offlineQueueStore,
    refreshUi: () => {
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
      void statusBar.refresh();
    },
  });

  registerWatchModePoller(context, {
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
    getEncKey,
    makeEngine,
    offlineQueue: offlineQueueStore,
    refreshUi: async () => {
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
      await statusBar.refresh();
    },
  };

  registerGitBranchWorkspaceActivation(context, gitBranchActivationDeps);

  registerSyncScheduleTransition(context, {
    store: scheduleDeferredStore,
    flushDeps: {
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
        void statusBar.refresh();
      },
    },
    statusBar,
  });

  registerAutoPauseMonitor(context);

  registerOfflineRecoveryMonitor(context, {
    offlineQueue: offlineQueueStore,
    globalConfig,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    makeEngine: (root, provider, machineId, machineName) =>
      makeEngine(root, provider, machineId, machineName),
    statusBar,
    refreshUi: () => {
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
      void statusBar.refresh();
    },
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


  const providerAuthFlows = createProviderAuthFlows({
    context,
    globalConfig,
    workspacesTree,
    statusBar,
    fileDecorations,
    refreshActiveEditor: () => { void refreshActiveEditorSyncContext(); },
    refreshCloudWebhooks,
  });

  registerProviderMigrationCommand(context, {
    registry,
    globalConfig,
    workspacesTree,
    makeEngine,
    signInOneDrive: () => providerAuthFlows.oneDrive(true),
    signInGoogleDrive: () => providerAuthFlows.googleDrive(true),
    signInDropbox: () => providerAuthFlows.dropbox(true),
    signInYandexDisk: () => providerAuthFlows.yandexDisk(true),
    refreshUi: async () => {
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
      refreshCloudWebhooks();
    },
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
      getEncKey,
      makeEngine,
      roots,
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
  const makeEngineForRoot = async (root: string, provider: ICloudProvider) => { const gc = await globalConfig.load(); return makeEngine(root, provider, gc.machineId, gc.machineName); };
  context.subscriptions.push(...registerSmartFeaturesEngineCommands({ context, globalConfig, tryAuthenticatedProvider: tap }), ...registerHashMigrationCommands({ context, tryAuthenticatedProvider: tap, makeEngineForRoot }), ...registerP2PSessionCommands({ context, registry: p2pSessionRegistry, tryAuthenticatedProvider: tap, globalConfig, mirrorRegistry: p2pMirrorRegistry, logSyncActivity }), ...registerOAuthDeviceCodeCommand({ context, resolveProviders: () => resolveDeviceCodeProviders(context) }));

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
    runAfterSessionResume: async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const providerOrNull = await tryAuthenticatedProvider(registry);
      if (!providerOrNull) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: провайдер не авторизован — выполните Pull/Push вручную после снятия паузы.",
        );
        syncSessionPause.clearPendingDocs();
        await statusBar.refresh();
        return;
      }
      const provider = providerOrNull;
      const gcfg = await globalConfig.load();
      const allPlans: Awaited<ReturnType<SyncEngine["previewSyncPlan"]>> = [];
      let anyRoot = false;
      for (const folder of folders) {
        const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
        if (wc.activeWorkspaces.length === 0) {
          continue;
        }
        anyRoot = true;
        const engine = makeEngine(folder.uri.fsPath, provider, gcfg.machineId, gcfg.machineName);
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
      const nPush = allPlans.reduce((acc, w) => acc + w.files.filter((f) => f.action === "push").length, 0);
      const nPull = allPlans.reduce((acc, w) => acc + w.files.filter((f) => f.action === "pull").length, 0);
      const nConf = allPlans.reduce(
        (acc, w) =>
          acc + w.files.filter((f) => f.action === "conflict" || f.action === "conflict_pending").length,
        0,
      );
      const choice = await vscode.window.showWarningMessage(
        [
          "VSCodeSync: пауза снята.",
          `План: ↑ push ${String(nPush)} · ↓ pull ${String(nPull)} · конфликты ${String(nConf)}.`,
          "Детали — Output «VSCodeSync · Preview».",
        ].join("\n"),
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
          bypassSchedule: true,
          bypassAutoPause: true,
          bypassRateLimit: true,
          refreshUi: () => {
            workspacesTree.refresh();
            fileDecorations.refresh();
            void refreshActiveEditorSyncContext();
          },
        });
      }
      syncSessionPause.clearPendingDocs();
      await statusBar.refresh();
    },
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
    getEncKey,
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

  // Live presence heartbeat — opt-in via `presenceHeartbeatMinutes`.
  registerPresenceHeartbeat(context, {
    globalConfig,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
  });

  // Cross-cloud backup mirror — opt-in via `backup.secondaryProvider`.
  registerCrossCloudBackup(context, {
    globalConfig,
    registry,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
  });

  // Scheduled snapshots (daily / weekly via vscodesync.snapshotSchedule).
  registerScheduledSnapshots(context, {
    getCandidateFolders: () => vscode.workspace.workspaceFolders ?? [],
    snapshotFolder: async (folderRoot) => {
      const wc = await WorkspaceConfigManager.load(folderRoot);
      if (wc.activeWorkspaces.length === 0) return;
      const provider = await tryAuthenticatedProvider(registry);
      if (!provider) return;
      const gc = await globalConfig.load();
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const retentionDays = cfg.get<number>("snapshotRetentionDays", 180);
      const maxPerWorkspace = cfg.get<number>("maxSnapshotsPerWorkspace", 20);
      const { createWorkspaceSnapshot, listWorkspaceSnapshots, deleteWorkspaceSnapshot } =
        await import("./core/snapshotsEngine.js");
      const { planSnapshotRetention } = await import("./core/snapshotRetentionPlan.js");
      for (const aw of wc.activeWorkspaces) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          await createWorkspaceSnapshot(provider, folderRoot, aw.workspaceId, `auto-${stamp}`, gc.machineName);
        } catch {
          /* non-fatal — surfaces in next manual snapshot */
          continue;
        }
        try {
          const snapshots = await listWorkspaceSnapshots(provider, aw.workspaceId);
          const plan = planSnapshotRetention({ snapshots, retentionDays, maxPerWorkspace });
          for (const s of plan.delete) {
            await deleteWorkspaceSnapshot(provider, aw.workspaceId, s.name);
          }
        } catch {
          /* retention is best-effort — never fail the snapshot itself */
        }
      }
    },
  });
}

export function deactivate(): void {
  void disposeWorkspaceInstanceLock();
  disposeAllGlobalQueues();
}
