import * as vscode from "vscode";
import * as path from "node:path";
import { GlobalConfigManager } from "./core/globalConfigManager.js";
import { initLog } from "./utils/logVscode.js";
import { verboseLog } from "./utils/log.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ensureWorkspaceGitignoreEntry } from "./core/workspaceGitignore.js";
import { OneDriveProvider } from "./providers/onedrive/onedriveProvider.js";
import { readOneDriveTokenBundle } from "./providers/onedrive/onedriveProvider.js";
import { GdriveProvider } from "./providers/gdrive/gdriveProvider.js";
import { DropboxProvider } from "./providers/dropbox/dropboxProvider.js";
import { YandexDiskProvider } from "./providers/yandex/yandexDiskProvider.js";
import { appendActivityEvent, type ActivityEventInput } from "./core/activityLog.js";
import { recordCompressionSaving, recordTransferBytes, type SyncTransferEvent } from "./core/syncStatsStore.js";
import { SyncEngine } from "./core/syncEngine.js";
import type { PurgeLostFileItem } from "./core/syncEngine.js";
import { encryptBuffer, decryptBuffer } from "./core/encryption.js";
import { readEncryptionKey, ensureEncryptionKey } from "./core/encryptionKey.js";
import type { ICloudProvider } from "./providers/cloudProviderTypes.js";
import { ProviderError } from "./providers/cloudProviderTypes.js";
import { wrapWithQueue } from "./core/queuedProvider.js";
import { disposeAllGlobalQueues } from "./core/requestQueue.js";
import { WorkspaceConfigManager } from "./core/workspaceConfigManager.js";
import { trackedLocalAbsolutePath } from "./core/pathMapping.js";
import type { ActiveWorkspaceEntry, TrackedFile, ProviderType } from "./core/types.js";
import { SyncStatusBarController } from "./ui/statusBar.js";
import { WorkspacesTreeProvider, type SyncTreeElement } from "./ui/workspacesTree.js";
import { WorkspacesTreeDnD } from "./ui/workspacesTreeDnD.js";
import { SyncFileDecorationController } from "./ui/fileDecorations.js";
import { guardPathsBeforeAdd } from "./ui/syncGuards.js";
import { writeSyncPreviewOutput } from "./ui/syncPreviewUi.js";
import { registerActiveEditorSyncContext, refreshActiveEditorSyncContext } from "./ui/editorSyncContext.js";
import { registerProviderMigrationCommand } from "./ui/providerMigrationUi.js";
import { registerQuickTransferFeatures } from "./ui/quickTransferUi.js";
import { registerPlannedPaletteCommands } from "./ui/plannedPaletteCommands.js";
import { registerVscodeSyncTaskProvider } from "./ui/vscodeSyncTaskProvider.js";
import { syncMachinesRegistrySelf } from "./core/machineRegistry.js";
import { classifyExpiry, formatExpiryHint } from "./core/tokenExpiryHints.js";
import { SyncScheduleDeferredStore } from "./core/syncScheduleDeferredStore.js";
import { SyncOfflineQueueStore } from "./core/syncOfflineQueueStore.js";
import { scheduleStartupSyncSummary } from "./ui/syncSummaryStartup.js";
import { scheduleWorkspaceInactiveArchivePrompt } from "./ui/workspaceInactiveArchive.js";
import { scheduleSmartWorkspaceSuggestions } from "./ui/smartWorkspaceSuggestions.js";
import { scheduleMachineApprovalNotifier } from "./ui/machineApprovalNotifications.js";
import { applyArchivedTagAndSuspend } from "./ui/workspaceArchiveOps.js";
import { newestTrackedLastSyncMs } from "./utils/workspaceLastActivity.js";
import { evaluateLongAbsence, type LongAbsenceWorkspaceInput } from "./core/longAbsenceEvaluator.js";
import { syncAutoPause } from "./core/syncAutoPause.js";
import { registerAutoPauseMonitor } from "./ui/syncAutoPauseMonitor.js";
import { registerSyncScheduleTransition } from "./ui/syncScheduleTransition.js";
import { isAutoSyncBlockedBySchedule } from "./ui/syncScheduleGate.js";
import { registerSyncTriggerManager } from "./ui/syncTriggerManager.js";
import { startDigestTimer, recordDigestPush, recordDigestPull, recordDigestConflict } from "./ui/notificationService.js";
import { registerOfflineRecoveryMonitor } from "./ui/syncOfflineRecoveryMonitor.js";
import { runQuietFullSyncAllFolders } from "./ui/quietFullSyncAllFolders.js";
import type { QuietFullSyncAllFoldersDeps } from "./ui/quietFullSyncAllFolders.js";
import { registerWatchModePoller } from "./ui/watchModePoller.js";
import { registerOneDriveWebhookLifecycle } from "./ui/oneDriveWebhookLifecycle.js";
import { registerGoogleDriveWebhookLifecycle } from "./ui/googleDriveWebhookLifecycle.js";
import { registerGitBranchWorkspaceActivation } from "./ui/gitBranchWorkspaceActivation.js";
import { syncSessionPause } from "./core/syncSessionPause.js";
import type { LineEndingMode } from "./utils/normalize.js";
import {
  disposeWorkspaceInstanceLock,
  scheduleWorkspaceInstanceLockRefresh,
} from "./core/workspaceInstanceLock.js";
import { registerVsCodeSyncTelemetry } from "./telemetry/extensionTelemetry.js";
import { runOnboardingWizard } from "./ui/onboarding.js";
import { SyncTimelineProvider } from "./ui/syncTimelineProvider.js";
import { registerProviderSetupGuide } from "./ui/providerSetupGuide.js";
import { registerCommandCenter } from "./ui/commandCenter.js";
import { registerSettingsPanel } from "./ui/settingsPanel.js";
import { registerHealthAutoCheck } from "./ui/healthAutoCheck.js";
import { registerScheduledSnapshots } from "./ui/scheduledSnapshots.js";
import { SyncLastSyncCodeLensProvider } from "./ui/lastSyncCodeLens.js";
import { InlineConflictCodeLensProvider } from "./ui/inlineConflictCodeLens.js";
import {
  ConflictHotZoneCodeLensProvider,
  makeToRelPath,
} from "./ui/conflictHotZoneCodeLens.js";
import { registerTunnelBackend } from "./ui/tunnelProviderRegistry.js";
import { cloudflaredTunnelBackend } from "./ui/tunnelBackendCloudflared.js";
import { tailscaleFunnelTunnelBackend } from "./ui/tunnelBackendTailscale.js";
import { HoverDiffPreviewProvider } from "./ui/hoverDiffPreviewProvider.js";
import { scheduleAchievementsWarmup } from "./ui/achievementsService.js";
import { registerSmartFeaturesCommands } from "./commands/registerSmartFeatures.js";
import { registerTunnelStatusCommand } from "./commands/registerTunnelStatusCommand.js";
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
import {
  WORKSPACES_NOTE_FILTER_KEY,
  WORKSPACES_TAG_FILTERS_KEY,
  WORKSPACES_SHOW_ARCHIVED_KEY,
  applyWorkspacesTreeFilterChrome,
} from "./ui/workspacesTreeFilterState.js";
import { pickRoot } from "./commands/_shared.js";
import { ActivityAlertMonitor } from "./ui/activityAlertMonitor.js";

const CFG_SECTION = "vscodesync";

/** Dedupe VS Code warnings when multiple engines hash the same tracked path in one session. */
const warnedEncodingIssueKeys = new Set<string>();

/** Set in `activate`; used by `makeEngine` and manual activity rows (conflict resolution). */
let logSyncActivityRef: ((ev: ActivityEventInput) => void) | undefined;

let logSyncStatsTransferRef: ((ev: SyncTransferEvent) => void) | undefined;
let logSyncCompressionRef: ((plaintextBytesSaved: number) => void) | undefined;
const warnedPreserveLfConflictKeys = new Set<string>();
/** When Timeline Provider is created, notify it on new sync events. */
let timelineFireChangeRef: (() => void) | undefined;
/** Dedupe purge-lost warnings per session: key = workspaceId:relPath. */
const warnedPurgeLostKeys = new Set<string>();
/** Dedupe new-conflict notifications per session: key = workspaceId:relPath. */
const notifiedConflictKeys = new Set<string>();
/** Dedupe schema-version-too-new warnings per session: key = workspaceId. */
const warnedSchemaVersionKeys = new Set<string>();
const warnedCorruptManifestKeys = new Set<string>();
/** Dedupe remote-workspace-deleted notifications per session: key = workspaceId. */
const warnedRemoteDeletedKeys = new Set<string>();
/** Set in `activate`; called by makeEngine's onRemoteWorkspaceDeleted to refresh the sidebar tree. */
let treeRefreshRef: (() => void) | undefined;
/** Set in `activate`; called by makeEngine's onRemoteWorkspaceDeleted when user chooses to re-upload. */
let repushDeletedWorkspaceRef:
  | ((workspaceId: string, localRoot: string, savedEntry: ActiveWorkspaceEntry, savedFiles: TrackedFile[]) => Promise<void>)
  | undefined;

function syncWarnDedupeKey(workspaceRoot: string, segment: string, rel: string): string {
  return `${workspaceRoot}\u0000${segment}\u0000${rel}`;
}


function roots(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}



// ─── Inline diff helper (verbose pull notifications) ─────────────────────────

/**
 * Computes a compact +/- line diff between two texts.
 * Returns null when there are no changes or when total changed lines exceed `maxLines`.
 */
function buildInlineDiff(oldText: string, newText: string, maxLines = 20): string | null {
  if (oldText === newText) return null;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed = oldLines.filter((l) => !newSet.has(l));
  const added = newLines.filter((l) => !oldSet.has(l));
  if (removed.length + added.length === 0 || removed.length + added.length > maxLines) {
    return null;
  }
  const parts: string[] = [];
  for (const l of removed) {
    parts.push(`- ${l}`);
  }
  for (const l of added) {
    parts.push(`+ ${l}`);
  }
  return parts.join("\n");
}

/** Returns the onFilePulled callback for SyncEngine; only active in verbose mode. */
function makeOnFilePulledCallback(): (posixRel: string, oldContent: string | null, newContent: string) => void {
  return (posixRel, oldContent, newContent): void => {
    const level = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("notificationLevel", "normal");
    if (level !== "verbose") return;
    const diff = buildInlineDiff(oldContent ?? "", newContent);
    const fileName = posixRel.split("/").pop() ?? posixRel;
    if (diff !== null) {
      void vscode.window.showInformationMessage(`VSCodeSync: ↓ ${fileName}\n${diff}`);
    } else {
      void vscode.window.showInformationMessage(`VSCodeSync: ↓ ${fileName} обновлён`);
    }
  };
}

function makeEngine(
  workspaceRoot: string,
  provider: ICloudProvider,
  machineId: string,
  machineName: string,
  encKey?: Buffer | null,
): SyncEngine {
  const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
  const mb = cfg.get<number>("maxFileSizeMB", 5);
  const maxB = Math.max(0, mb) * 1024 * 1024;
  const leRaw = cfg.get<string>("lineEnding", "lf");
  const lineEnding: LineEndingMode =
    leRaw === "crlf" || leRaw === "preserve" ? leRaw : "lf";
  const localBackupEnabled = cfg.get<boolean>("localBackupEnabled", true);
  const localBackupRetentionDays = cfg.get<number>("localBackupRetentionDays", 7);
  const encryptionOn = cfg.get<boolean>("encryption", false);
  const compressUploads = cfg.get<boolean>("compressUploads", false);
  const key = encryptionOn && encKey ? encKey : null;
  return new SyncEngine({
    workspaceRoot,
    provider: wrapWithQueue(provider),
    machineId,
    machineName,
    maxFileSizeBytes: maxB > 0 ? maxB : undefined,
    lineEnding,
    // VSCodeSync v1 supports UTF-8 only; surface BOM / invalid UTF-8.
    encodingLint: true,
    localBackupEnabled,
    localBackupRetentionDays,
    encrypt: key ? (buf) => encryptBuffer(key, buf) : undefined,
    decrypt: key ? (buf) => decryptBuffer(key, buf) : undefined,
    onFilePulled: makeOnFilePulledCallback(),
    onEncodingIssue: (kind, rel) => {
      const k = syncWarnDedupeKey(workspaceRoot, kind, rel);
      if (warnedEncodingIssueKeys.has(k)) {
        return;
      }
      warnedEncodingIssueKeys.add(k);
      const tip =
        kind === "bom"
          ? `UTF-8 BOM в «${rel}» исключается из канона; сохраните файл без BOM для предсказуемости.`
          : `«${rel}»: недопустимые UTF‑8 последовательности; канон использует замену символов.`;
      void vscode.window.showWarningMessage(`VSCodeSync: ${tip}`);
    },
    onPreserveLineEndingConflictHint:
      lineEnding === "preserve"
        ? (rel) => {
            const k = syncWarnDedupeKey(workspaceRoot, "preserve-le", rel);
            if (warnedPreserveLfConflictKeys.has(k)) {
              return;
            }
            warnedPreserveLfConflictKeys.add(k);
            void vscode.window.showWarningMessage(
              `VSCodeSync: возможный конфликт только из‑за переводов строк («${rel}»). При lineEnding=preserve хэш зависит от CR/LF; рассмотрите lf или crlf.`,
            );
          }
        : undefined,
    requireMachineApproval: () =>
      vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("requireMachineApproval", false),
    onSyncActivity: (ev) => {
      logSyncActivityRef?.(ev);
    },
    onTransfer: (ev) => {
      logSyncStatsTransferRef?.(ev);
    },
    compressUploads: compressUploads && !encryptionOn,
    onCompressionSaving: (saved) => {
      logSyncCompressionRef?.(saved);
    },
    deltaSync: cfg.get<boolean>("deltaSync", false),
    deltaThresholdKB: cfg.get<number>("deltaThresholdKB", 100),
    onPurgeLostFiles: (items: PurgeLostFileItem[]) => {
      // Dedupe per session to avoid repeated warnings on every auto-sync
      const fresh = items.filter((i) => {
        const k = `${i.workspaceId}:${i.relPath}`;
        if (warnedPurgeLostKeys.has(k)) {
          return false;
        }
        warnedPurgeLostKeys.add(k);
        return true;
      });
      if (fresh.length === 0) {
        return;
      }
      const label =
        fresh.length === 1
          ? `«${fresh[0]?.relPath ?? ""}»`
          : `${String(fresh.length)} файлов`;
      void vscode.window
        .showWarningMessage(
          `VSCodeSync: ${label} потерял(и) синхронизацию — файл был удалён другой машиной пока вы были офлайн, и tombstone уже очищен (>${String(vscode.workspace.getConfiguration(CFG_SECTION).get<number>("tombstonePurgeDays", 30))} дней).`,
          "Подробнее",
        )
        .then((choice) => {
          if (choice !== "Подробнее") {
            return;
          }
          const ch = vscode.window.createOutputChannel("VSCodeSync: Потерянные файлы");
          ch.appendLine(
            "Файлы отслеживались в VSCodeSync, но tombstone в манифесте уже очищен.",
          );
          ch.appendLine(
            "Это означает: файл удалён другой машиной более tombstonePurgeDays дней назад.",
          );
          ch.appendLine(
            "Локальная копия на диске НЕ удалена — она просто больше не синхронизируется.",
          );
          ch.appendLine("");
          for (const item of fresh) {
            ch.appendLine(`  Workspace : ${item.workspaceNote} (${item.workspaceId})`);
            ch.appendLine(`  Файл      : ${item.relPath}`);
            ch.appendLine("");
          }
          ch.appendLine(
            "Для восстановления синхронизации: VSCodeSync: Add Current File → выберите workspace.",
          );
          ch.show();
        });
    },
    onNewConflict: (workspaceId: string, workspaceNote: string, relPath: string, isBinary: boolean) => {
      const k = `${workspaceId}:${relPath}`;
      if (notifiedConflictKeys.has(k)) {
        return;
      }
      notifiedConflictKeys.add(k);
      const basename = relPath.split("/").pop() ?? relPath;
      const wsLabel = workspaceNote || workspaceId;
      const msgPrefix = isBinary
        ? `VSCodeSync ⚠ Конфликт бинарного файла «${basename}» в workspace «${wsLabel}».`
        : `VSCodeSync ⚠ Конфликт «${basename}» в workspace «${wsLabel}».`;
      void vscode.window
        .showWarningMessage(`${msgPrefix} Разрешите через боковую панель или «VSCodeSync: Resolve Conflicts».`, "Resolve Now")
        .then((choice) => {
          if (choice === "Resolve Now") {
            void vscode.commands.executeCommand("vscodesync.resolveConflicts");
          }
        });
    },
    onSchemaVersionTooNew: (workspaceId: string, detectedVersion: number) => {
      if (warnedSchemaVersionKeys.has(workspaceId)) {
        return;
      }
      warnedSchemaVersionKeys.add(workspaceId);
      void vscode.window.showWarningMessage(
        `VSCodeSync: workspace ${workspaceId} использует schemaVersion ${String(detectedVersion)}, которую эта версия расширения не поддерживает (поддерживается v${String(1)}). Синхронизация приостановлена для этого workspace. Обновите расширение VSCodeSync.`,
        "Проверить обновления",
      ).then((choice) => {
        if (choice === "Проверить обновления") {
          void vscode.commands.executeCommand("workbench.extensions.search", "vscodesync");
        }
      });
    },
    onCorruptManifest: (workspaceId: string, reason: string) => {
      if (warnedCorruptManifestKeys.has(workspaceId)) {
        return;
      }
      warnedCorruptManifestKeys.add(workspaceId);
      void vscode.window.showErrorMessage(
        `VSCodeSync: облачный манифест workspace ${workspaceId} повреждён (${reason}). Запустить Repair State?`,
        "Repair State",
      ).then((choice) => {
        if (choice === "Repair State") {
          void vscode.commands.executeCommand("vscodesync.repairState");
        }
      });
    },
    onMassChange: async (workspaceId: string, report) => {
      const enabled = vscode.workspace
        .getConfiguration("vscodesync")
        .get<boolean>("massChangeGuard", true);
      if (!enabled) return true;
      const { describeMassChange } = await import("./core/massChangeGuard.js");
      const message = describeMassChange(report);
      const choice = await vscode.window.showWarningMessage(
        `VSCodeSync · ${workspaceId}: ${message}`,
        { modal: true },
        "Создать snapshot и продолжить",
        "Продолжить без snapshot",
      );
      if (choice === undefined) return false;
      if (choice === "Создать snapshot и продолжить") {
        try {
          await vscode.commands.executeCommand("vscodesync.createSnapshot");
        } catch {
          /* user-cancelled snapshot is non-fatal — they explicitly opted to proceed */
        }
      }
      return true;
    },
    onRemoteWorkspaceDeleted: (
      workspaceId: string,
      workspaceNote: string,
      workspaceRoot: string,
      savedEntry: ActiveWorkspaceEntry,
      savedFiles: TrackedFile[],
    ) => {
      if (warnedRemoteDeletedKeys.has(workspaceId)) {
        return;
      }
      warnedRemoteDeletedKeys.add(workspaceId);
      treeRefreshRef?.();
      const label = workspaceNote.trim().length > 0 ? `«${workspaceNote}»` : workspaceId;
      void (async () => {
        const choice = await vscode.window.showWarningMessage(
          `VSCodeSync: workspace ${label} удалён с облака другой машиной — отключён локально. Залить обратно на облако?`,
          "Залить на облако",
        );
        if (choice === "Залить на облако") {
          void repushDeletedWorkspaceRef?.(workspaceId, workspaceRoot, savedEntry, savedFiles);
        }
      })();
    },
  });
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

  // Tunnel backends — register both v2 backends in their skeleton form so the
  // dispatcher returns "not_available" with a useful detail (probe + TODO)
  // instead of "backend not registered". The actual spawn lands in v2.4.
  registerTunnelBackend(cloudflaredTunnelBackend);
  registerTunnelBackend(tailscaleFunnelTunnelBackend);

  registerVsCodeSyncTelemetry(context, globalConfig, CFG_SECTION);
  registerProviderSetupGuide(context);
  registerCommandCenter(context);
  registerSettingsPanel(context);

  const activityAlertMonitor = new ActivityAlertMonitor(context);
  context.subscriptions.push(activityAlertMonitor);
  logSyncActivityRef = (ev) => {
    const retention = vscode.workspace.getConfiguration(CFG_SECTION).get<number>("activityRetentionDays", 90);
    void appendActivityEvent(globalConfig.getStorageDir(), ev, retention);
    timelineFireChangeRef?.();
    activityAlertMonitor.notify(ev);
    // Feed into notification digest
    if (ev.kind === "push") {
      recordDigestPush(1, ev.machineName);
    } else if (ev.kind === "pull") {
      recordDigestPull(1, ev.machineName);
    } else if (ev.kind === "conflict") {
      recordDigestConflict(ev.relPath);
    }
    // The conflict heatmap is fed only by the inline-CodeLens commands
    // (vscodesync.{keepMine,takeTheirs}WithRange) which know the real line
    // range of the resolved block. Tree- and palette-level resolve commands
    // operate file-level and are intentionally not recorded — a file-level
    // 1..1 sentinel hid the actual hot-zones in the data.

    // Feed into the sync-replay recorder when an active session is running.
    void (async () => {
      try {
        const { feedActivity } = await import("./ui/syncReplayRecorderState.js");
        feedActivity(ev);
      } catch { /* recorder is best-effort; silent */ }
    })();
  };
  logSyncStatsTransferRef = (ev) => {
    void recordTransferBytes(globalConfig.getStorageDir(), ev);
  };
  logSyncCompressionRef = (saved) => {
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

  // Last-sync CodeLens — visible over every tracked file (toggle via vscodesync.codeLens.enabled).
  const lastSyncLens = new SyncLastSyncCodeLensProvider();
  context.subscriptions.push(
    lastSyncLens,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lastSyncLens),
    vscode.workspace.onDidSaveTextDocument(() => { lastSyncLens.refresh(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.codeLens")) lastSyncLens.refresh();
    }),
  );

  // Inline conflict CodeLens — over <<< / === / >>> marker blocks.
  const inlineConflictLens = new InlineConflictCodeLensProvider(
    () => vscode.workspace.getConfiguration("vscodesync").get<boolean>("aiMerge", false),
  );
  context.subscriptions.push(
    inlineConflictLens,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, inlineConflictLens),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Only refresh when the changed document might have markers — cheap heuristic.
      const text = e.document.getText();
      if (text.includes("<<<<<<<") || text.includes(">>>>>>>")) inlineConflictLens.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("vscodesync.inlineConflictCodeLens") ||
        e.affectsConfiguration("vscodesync.aiMerge")
      ) {
        inlineConflictLens.refresh();
      }
    }),
  );

  // Conflict hot-zone CodeLens — flags lines that have been part of resolved
  // conflicts ≥ N times in the last 180 days. Pure planner clamps to the
  // current document's line count.
  const hotZoneLens = new ConflictHotZoneCodeLensProvider({
    storageDir: globalConfig.getStorageDir(),
    toRelPath: makeToRelPath(),
  });
  context.subscriptions.push(
    hotZoneLens,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, hotZoneLens),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.conflictHotZoneCodeLens")) hotZoneLens.refresh();
    }),
  );

  // Hover Diff Preview — MarkdownString hover over tracked files showing
  // sync status + last-sync age + Pull / Resolve action links.
  const hoverDiff = new HoverDiffPreviewProvider();
  context.subscriptions.push(
    hoverDiff,
    vscode.languages.registerHoverProvider({ scheme: "file" }, hoverDiff),
    vscode.workspace.onDidSaveTextDocument(() => { hoverDiff.refresh(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.hoverDiffPreview")) hoverDiff.refresh();
    }),
  );

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
    ...registerTunnelStatusCommand(),
  );

  // Smart Conflict Prediction — status-bar warning when another machine has
  // marked itself as editing the same active file.
  const conflictPredictor = new SmartConflictPredictionService(globalConfig);
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
  treeRefreshRef = () => { workspacesTree.refresh(); };
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
    if (!encOn) {
      return null;
    }
    return readEncryptionKey(context.secrets);
  };

  let _rweSeq = 0;
  const runWithEngine = async (
    fn: (engine: SyncEngine, root: string, gc: GlobalConfigManager) => Promise<void>,
    workspaceRoot?: string,
    options?: { showErrorDialog?: boolean },
  ): Promise<void> => {
    const seq = ++_rweSeq;
    verboseLog("rwe", `#${String(seq)} START fn=${fn.name || "(anon)"}`);
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
    try {
      await fn(engine, root, globalConfig);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (options?.showErrorDialog !== false) {
        // Special handling for expired/missing credentials
        if (e instanceof ProviderError && e.code === "UNAUTHORIZED") {
          const gc = await globalConfig.load();
          const providerName = gc.activeProvider ?? "провайдер";
          const choice = await vscode.window.showErrorMessage(
            `VSCodeSync: сессия ${providerName} истекла или недействительна. Необходима повторная авторизация.`,
            "Войти снова",
          );
          if (choice === "Войти снова") {
            await vscode.commands.executeCommand("vscodesync.setActiveProvider");
          }
        } else {
          await vscode.window.showErrorMessage(`VSCodeSync: ${msg}`);
        }
      } else {
        throw e;
      }
    } finally {
      verboseLog("rwe", `#${String(seq)} finally`);
      statusBar.setSyncing(false);
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }
  };

  /** Create a cloud workspace, then add selected files/folders (same rules as add to existing). */

  // Set after runWithEngine is defined — uses it in closure.
  repushDeletedWorkspaceRef = async (workspaceId, localRoot, savedEntry, savedFiles) => {
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

  const refreshCloudWebhooks = (): void => {
    void oneDriveWebhookLifecycle.refresh();
    void googleDriveWebhookLifecycle.refresh();
  };

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

  const workspacesTreeDnD = new WorkspacesTreeDnD({
    onMoveFilesToWorkspace: async ({ folderRoot, targetWorkspaceId, sources }) => {
      const wc = await WorkspaceConfigManager.load(folderRoot);
      const gconf = await globalConfig.load();
      const ent = wc.activeWorkspaces.find((w) => w.workspaceId === targetWorkspaceId);
      const absPaths = sources.map((s) =>
        trackedLocalAbsolutePath(folderRoot, wc.pathMapping, gconf.machineName, s.localPath),
      );
      if (
        !(await guardPathsBeforeAdd(absPaths, false, folderRoot, {
          entry: ent,
          cfg: wc,
          machineName: gconf.machineName,
        }))
      ) {
        return;
      }
      await runWithEngine(async (engine) => {
        for (const s of sources) {
          const abs = path.join(folderRoot, ...s.localPath.split("/"));
          await engine.removeTrackedFiles(s.workspaceId, [abs]);
          await engine.addFiles(targetWorkspaceId, [abs]);
        }
        await vscode.window.showInformationMessage(
          sources.length === 1
            ? "Файл перемещён в другой workspace."
            : `Перемещено файлов: ${String(sources.length)}.`,
        );
      }, folderRoot);
    },
  });

  workspacesTree.setFetchRemoteSummaries(async () => {
    const root = pickRoot();
    if (!root) {
      return [];
    }
    const provider = await ensureProvider(registry, globalConfig);
    if (!provider) {
      return [];
    }
    const cfg = await globalConfig.load();
    const engine = makeEngine(root, provider, cfg.machineId, cfg.machineName);
    return engine.listRemoteWorkspaceSummaries();
  });

  const treeView = vscode.window.createTreeView("vscodesync.workspaces", {
    treeDataProvider: workspacesTree,
    showCollapseAll: false,
    dragAndDropController: workspacesTreeDnD,
  });
  context.subscriptions.push(treeView);
  void applyWorkspacesTreeFilterChrome(treeView, workspacesTree);

  context.subscriptions.push(
    workspacesTree.onDidChangeTreeData(() => {
      void updateWorkspacesTreeBadge(treeView);
    }),
  );
  void updateWorkspacesTreeBadge(treeView);

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
      logSyncActivity: (ev) => { logSyncActivityRef?.(ev); },
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
      logSyncActivity: (ev) => { logSyncActivityRef?.(ev); },
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

  // File lifecycle events: deletions and renames of tracked files
  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles(async (e) => {
      for (const fileUri of e.files) {
        const fsPath = fileUri.fsPath;
        const folder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!folder) {
          continue;
        }
        const root = folder.uri.fsPath;
        const wc = await WorkspaceConfigManager.load(root);
        const rel = path.relative(root, fsPath).split(path.sep).join("/");
        const fileEntry = wc.files.find((f) => f.localPath === rel);
        if (!fileEntry) {
          continue;
        }
        const choice = await vscode.window.showWarningMessage(
          `VSCodeSync: «${path.basename(fsPath)}» удалён локально. Что сделать с синхронизацией?`,
          "Убрать из синхронизации",
          "Восстановить файл",
          "Ничего",
        );
        if (!choice || choice === "Ничего") {
          continue;
        }
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
        if (!folder) {
          continue;
        }
        const root = folder.uri.fsPath;
        const wc = await WorkspaceConfigManager.load(root);
        const oldRel = path.relative(root, oldUri.fsPath).split(path.sep).join("/");
        const fileEntry = wc.files.find((f) => f.localPath === oldRel);
        if (!fileEntry) {
          continue;
        }
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

  // Soft Lock lifecycle: track which files are open in the editor and set/clear editingBy in the manifest
  {
    // Maps fsPath → { root, workspaceId, relPath, lastActivityMs } for currently-locked files
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

    // Heartbeat + timeout check
    const heartbeatHandle = setInterval(() => {
      const now = Date.now();
      for (const [fsPath, entry] of softLockRegistry) {
        if (now - entry.lastActivityMs > SOFT_LOCK_TIMEOUT_MS) {
          // Timed out — clear lock
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

  const startupChannel = vscode.window.createOutputChannel("VSCodeSync · Startup");
  context.subscriptions.push(startupChannel);
  scheduleStartupSyncSummary(context, {
    startupChannel,
    globalConfig,
    getConfiguration: () => vscode.workspace.getConfiguration(CFG_SECTION),
    workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    loadWorkspaceConfig: (r) => WorkspaceConfigManager.load(r),
    pullAllQuiet: async (folderRoot: string) => {
      if (syncSessionPause.isPaused()) {
        return;
      }
      const provider = await tryAuthenticatedProvider(registry);
      if (!provider) {
        return;
      }
      const cfg = await globalConfig.load();
      const engine = makeEngine(folderRoot, provider, cfg.machineId, cfg.machineName);
      verboseLog("startup", `pullAll START ${folderRoot}`);
      statusBar.setSyncing(true);
      try {
        await engine.pullAll();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        startupChannel.appendLine(`Pull (${folderRoot}): ${msg}`);
      } finally {
        verboseLog("startup", `pullAll DONE ${folderRoot}`);
        statusBar.setSyncing(false);
        await statusBar.refresh();
        workspacesTree.refresh();
        fileDecorations.refresh();
        void refreshActiveEditorSyncContext();
      }
    },
    deferAutomaticStartupPull: async () => {
      if (isAutoSyncBlockedBySchedule()) {
        await scheduleDeferredStore.enqueueFullSync();
        return true;
      }
      if (syncAutoPause.isActive()) {
        await scheduleDeferredStore.enqueueFullSync();
        return true;
      }
      return false;
    },
  });

  // Long-absence notification: warn if last sync was more than longAbsenceThresholdDays ago
  void (async () => {
    try {
      const threshDays = vscode.workspace
        .getConfiguration(CFG_SECTION)
        .get<number>("longAbsenceThresholdDays", 3);
      if (threshDays <= 0) {
        return;
      }
      const folders: LongAbsenceWorkspaceInput[] = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
        folders.push({
          folderPath: folder.uri.fsPath,
          workspaces: wc.activeWorkspaces.map((ws) => ({
            workspaceId: ws.workspaceId,
            workspaceNote: ws.workspaceNote || ws.workspaceId,
            lastSyncMs: newestTrackedLastSyncMs(wc, ws.workspaceId),
          })),
        });
      }
      const warnings = evaluateLongAbsence({ folders, thresholdDays: threshDays });
      for (const w of warnings) {
        const choice = await vscode.window.showWarningMessage(
          `VSCodeSync ⏰ Workspace «${w.workspaceNote}» не синхронизировался ${String(w.daysSinceLastSync)} дней.`,
          "Preview изменений",
          "Синхронизировать",
          "Пропустить",
        );
        if (choice === "Синхронизировать") {
          await vscode.commands.executeCommand("vscodesync.pullAll");
        } else if (choice === "Preview изменений") {
          await vscode.commands.executeCommand("vscodesync.previewSync");
        }
      }
    } catch {
      // Non-fatal startup check
    }
  })();

  // Token expiry warning: check if the active provider's access token is already expired
  void (async () => {
    try {
      const gc = await globalConfig.load();
      if (!gc.activeProvider) {
        return;
      }
      // Only OneDrive has no auto-refresh — check if stored token is expired or
      // close to it (7-day soft warning via classifyExpiry).
      if (gc.activeProvider === "onedrive") {
        const bundle = await readOneDriveTokenBundle(context.secrets);
        if (bundle) {
          const hint = classifyExpiry(bundle.expiresAtMs);
          const msg = formatExpiryHint("OneDrive", hint);
          if (msg) {
            const choice = await vscode.window.showWarningMessage(
              msg,
              "Войти снова",
              "Пропустить",
            );
            if (choice === "Войти снова") {
              await vscode.commands.executeCommand("vscodesync.onedriveSignIn");
            }
          }
        }
      }
    } catch {
      // Non-fatal
    }
  })();

  scheduleWorkspaceInactiveArchivePrompt(context, {
    startupChannel,
    globalConfig,
    getConfiguration: () => vscode.workspace.getConfiguration(CFG_SECTION),
    workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    loadWorkspaceConfig: (r) => WorkspaceConfigManager.load(r),
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    extensionContext: context,
    onArchive: async ({ folderRootFsPath, workspaceId, workspaceNote }) => {
      const provider = await tryAuthenticatedProvider(registry);
      if (!provider) {
        return;
      }
      const gc = await globalConfig.load();
      const engine = makeEngine(folderRootFsPath, provider, gc.machineId, gc.machineName);
      statusBar.setSyncing(true);
      try {
        await applyArchivedTagAndSuspend(engine, workspaceId);
        await vscode.window.showInformationMessage(
          `VSCodeSync: «${workspaceNote.trim() || workspaceId}» архивирован (archived + Suspend).`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        startupChannel.appendLine(`Archive inactive (${workspaceId}): ${msg}`);
        await vscode.window.showErrorMessage(`VSCodeSync: архивирование не выполнено — ${msg}`);
      } finally {
        statusBar.setSyncing(false);
        workspacesTree.refresh();
        await statusBar.refresh();
      }
    },
  });

  scheduleSmartWorkspaceSuggestions(context, {
    globalConfig,
    getConfiguration: () => vscode.workspace.getConfiguration(CFG_SECTION),
    workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    loadWorkspaceConfig: (r) => WorkspaceConfigManager.load(r),
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    startupChannel,
    onCreateWorkspaceWithFiles: async ({ folderRoot, note, absolutePaths }) => {
      const provider = await tryAuthenticatedProvider(registry);
      if (!provider) {
        throw new Error("Нет авторизованного провайдера");
      }
      const gc = await globalConfig.load();
      const encKey = await getEncKey();
      const engine = makeEngine(folderRoot, provider, gc.machineId, gc.machineName, encKey);
      const t = gc.activeProvider ?? "onedrive";
      const wid = await engine.createWorkspace(note, t);
      const wc = await WorkspaceConfigManager.load(folderRoot);
      const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wid);
      if (
        !(await guardPathsBeforeAdd(absolutePaths, false, folderRoot, {
          entry: ent,
          cfg: wc,
          machineName: gc.machineName,
        }))
      ) {
        throw new Error("Добавление файлов отменено");
      }
      await engine.addFiles(wid, absolutePaths);
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
      await statusBar.refresh();
    },
    onEarlyArchive: async ({ folderRootFsPath, workspaceId, workspaceNote }) => {
      const provider = await tryAuthenticatedProvider(registry);
      if (!provider) {
        return;
      }
      const gc = await globalConfig.load();
      const encKey = await getEncKey();
      const engine = makeEngine(folderRootFsPath, provider, gc.machineId, gc.machineName, encKey);
      statusBar.setSyncing(true);
      try {
        await applyArchivedTagAndSuspend(engine, workspaceId);
        await vscode.window.showInformationMessage(
          `VSCodeSync: «${workspaceNote.trim() || workspaceId}» архивирован (archived + Suspend).`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        startupChannel.appendLine(`Smart suggestions archive (${workspaceId}): ${msg}`);
        await vscode.window.showErrorMessage(`VSCodeSync: архивирование не выполнено — ${msg}`);
      } finally {
        statusBar.setSyncing(false);
        workspacesTree.refresh();
        await statusBar.refresh();
      }
    },
  });

  scheduleMachineApprovalNotifier(context, {
    extensionContext: context,
    globalConfig,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
    getEncKey: async () =>
      vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("encryption", false)
        ? await readEncryptionKey(context.secrets)
        : null,
    makeEngine,
    startupChannel,
  });

  startDigestTimer(context);

  // VSCode Timeline Integration: show sync events for tracked files in the Timeline view
  const timelineProvider = new SyncTimelineProvider(globalConfig);
  timelineFireChangeRef = () => { timelineProvider.fireChange(); };
  try {
    // Timeline API is stable in VSCode 1.44+ but not yet in @types/vscode@1.80 — use runtime registration
    const reg = (vscode.window as unknown as { registerTimelineProvider?: (...args: unknown[]) => vscode.Disposable }).registerTimelineProvider;
    if (typeof reg === "function") {
      context.subscriptions.push(reg.call(vscode.window, "file", timelineProvider));
    }
  } catch {
    // Non-fatal: Timeline integration unavailable in this VSCode build
  }
  context.subscriptions.push(timelineProvider);

  for (const wf of roots()) {
    void ensureWorkspaceGitignoreEntry(wf.uri, vscode.window.showInformationMessage);
  }

  void (async () => {
    try {
      const c = await globalConfig.load();
      if (!c.onboardingCompleted) {
        return;
      }
      const p = await tryAuthenticatedProvider(registry);
      if (!p) {
        return;
      }
      await syncMachinesRegistrySelf(p, c.machineId, c.machineName);
    } catch {
      /* не блокируем старт */
    }
  })();

  void (async () => {
    const c = await globalConfig.load();
    if (c.onboardingCompleted) {
      return;
    }
    await runOnboardingWizard(globalConfig, onboardingCloudDeps);
    await statusBar.refresh();
    workspacesTree.refresh();
  })();

  // Weekly background Health Check — silent on green, toast on warnings.
  void (async () => {
    const gcInit = await globalConfig.load();
    registerHealthAutoCheck(context, {
      globalConfig,
      tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
      createEngine: (root, p) => makeEngine(root, p, gcInit.machineId, gcInit.machineName),
      activeProvider: gcInit.activeProvider,
      machineId: gcInit.machineId,
      machineName: gcInit.machineName,
      offlineQueue: offlineQueueStore,
      scheduleDeferred: scheduleDeferredStore,
    });
  })();

  // vscode://borodatych.vscodesyncfiles/connect?provider=...&workspaceId=...
  // Lets a second machine import a workspace by following a share-link.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        void (async () => {
          if (uri.path !== "/connect") return;
          const params = new URLSearchParams(uri.query);
          const workspaceId = params.get("workspaceId")?.trim();
          const provider = params.get("provider")?.trim();
          if (!workspaceId) return;
          const choice = await vscode.window.showInformationMessage(
            `VSCodeSync: получен link для workspace ${workspaceId}${provider ? ` (${provider})` : ""}. Подключить?`,
            "Подключить",
            "Открыть провайдер-онбординг",
            "Отмена",
          );
          if (choice === "Открыть провайдер-онбординг") {
            await vscode.commands.executeCommand("vscodesync.startOnboarding");
            return;
          }
          if (choice === "Подключить") {
            // Pre-select provider if specified.
            if (provider) {
              const gc = await globalConfig.load();
              if (gc.activeProvider !== provider && ["onedrive", "gdrive", "yandex", "dropbox"].includes(provider)) {
                await vscode.commands.executeCommand("vscodesync.setActiveProvider");
              }
            }
            await vscode.commands.executeCommand("vscodesync.connectCloudWorkspace");
          }
        })();
      },
    }),
  );

  // shareWorkspaceLink — moved into registerWorkspaceMgmtCommands.

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
