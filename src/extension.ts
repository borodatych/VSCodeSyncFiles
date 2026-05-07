import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { GlobalConfigManager } from "./core/globalConfigManager.js";
import { initLog } from "./utils/logVscode.js";
import { verboseLog } from "./utils/log.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ensureWorkspaceGitignoreEntry } from "./core/workspaceGitignore.js";
import { OneDriveProvider } from "./providers/onedrive/onedriveProvider.js";
import { readOneDriveTokenBundle } from "./providers/onedrive/onedriveProvider.js";
import { runOneDriveDeviceCodeLogin } from "./providers/onedrive/onedriveDeviceCode.js";
import { GdriveProvider } from "./providers/gdrive/gdriveProvider.js";
import { runGoogleDriveDeviceCodeLogin } from "./providers/gdrive/gdriveDeviceCode.js";
import { DropboxProvider } from "./providers/dropbox/dropboxProvider.js";
import { DROPBOX_OAUTH_REDIRECT_URI, runDropboxOAuthLoopback } from "./providers/dropbox/dropboxPkceOAuth.js";
import { YandexDiskProvider } from "./providers/yandex/yandexDiskProvider.js";
import {
  YANDEX_OAUTH_REDIRECT_URI,
  runYandexOAuthLoopback,
} from "./providers/yandex/yandexPkceOAuth.js";
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
import { absoluteToTrackedPosix, trackedLocalAbsolutePath } from "./core/pathMapping.js";
import type { ActiveWorkspaceEntry, TrackedFile, ProviderType } from "./core/types.js";
import { normalizeWorkspaceSyncState } from "./core/types.js";
import { SyncStatusBarController } from "./ui/statusBar.js";
import { WorkspacesTreeProvider, type SyncTreeElement } from "./ui/workspacesTree.js";
import { WorkspacesTreeDnD } from "./ui/workspacesTreeDnD.js";
import { workspaceHealthEmoji, workspaceHealthFromLocalCfg } from "./ui/workspaceHealthLocal.js";
import { SyncFileDecorationController } from "./ui/fileDecorations.js";
import { guardPathsBeforeAdd, guardPathsBeforePush } from "./ui/syncGuards.js";
import { collectFilesToAddUnderRoots } from "./utils/syncAddCollect.js";
import { confirmTreeWorkspaceBulkSyncIfNeeded, writeSyncPreviewOutput } from "./ui/syncPreviewUi.js";
import { registerActiveEditorSyncContext, refreshActiveEditorSyncContext } from "./ui/editorSyncContext.js";
import { runActiveProviderSwitch } from "./ui/activeProviderSwitch.js";
import { registerProviderMigrationCommand } from "./ui/providerMigrationUi.js";
import { registerQuickTransferFeatures } from "./ui/quickTransferUi.js";
import { registerPlannedPaletteCommands } from "./ui/plannedPaletteCommands.js";
import { registerVscodeSyncTaskProvider } from "./ui/vscodeSyncTaskProvider.js";
import { syncMachinesRegistrySelf } from "./core/machineRegistry.js";
import { classifyExpiry, formatExpiryHint } from "./core/tokenExpiryHints.js";
import { buildHealthCheckReport } from "./ui/healthCheckReport.js";
import { SyncScheduleDeferredStore } from "./core/syncScheduleDeferredStore.js";
import { SyncOfflineQueueStore } from "./core/syncOfflineQueueStore.js";
import { scheduleStartupSyncSummary } from "./ui/syncSummaryStartup.js";
import { scheduleWorkspaceInactiveArchivePrompt } from "./ui/workspaceInactiveArchive.js";
import { scheduleSmartWorkspaceSuggestions } from "./ui/smartWorkspaceSuggestions.js";
import { scheduleMachineApprovalNotifier } from "./ui/machineApprovalNotifications.js";
import { applyArchivedTagAndSuspend, stripArchivedTagAndActivate } from "./ui/workspaceArchiveOps.js";
import { hasArchivedTag, newestTrackedLastSyncMs } from "./utils/workspaceLastActivity.js";
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
import { registerGitBranchWorkspaceActivation, applyBranchPolicyForRoot } from "./ui/gitBranchWorkspaceActivation.js";
import { listGitBranches } from "./utils/gitBranches.js";
import { syncSessionPause } from "./core/syncSessionPause.js";
import type { LineEndingMode } from "./utils/normalize.js";
import {
  disposeWorkspaceInstanceLock,
  forceAcquireWorkspaceInstanceLock,
  peekWorkspaceInstanceLockHolder,
  scheduleWorkspaceInstanceLockRefresh,
} from "./core/workspaceInstanceLock.js";
import { registerVsCodeSyncTelemetry } from "./telemetry/extensionTelemetry.js";
import { resolveDefaultWorkspaceRootFsPath } from "./utils/workspaceRootResolver.js";
import { runOnboardingWizard } from "./ui/onboarding.js";
import { SyncTimelineProvider } from "./ui/syncTimelineProvider.js";
import { runAiMerge, isAiMergeAvailable } from "./core/aiMerge.js";
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
import { registerPresenceHeartbeat } from "./ui/presenceHeartbeat.js";
import { registerCrossCloudBackup } from "./ui/crossCloudBackup.js";
import { registerPanelCommands } from "./commands/registerPanels.js";
import { registerActivitySearchCommands } from "./commands/registerActivitySearches.js";
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

const WORKSPACES_NOTE_FILTER_KEY = "vscodesync.workspacesNoteFilter";
const WORKSPACES_TAG_FILTERS_KEY = "vscodesync.workspacesTagFilters";
const WORKSPACES_SHOW_ARCHIVED_KEY = "vscodesync.workspacesShowArchived";

let workspacesFilterInputBox: vscode.InputBox | undefined;

async function collectAllWorkspaceTags(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const seen = new Map<string, string>();
  for (const folder of folders) {
    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
    for (const e of wc.activeWorkspaces) {
      for (const t of e.tags ?? []) {
        const trim = t.trim();
        if (!trim) {
          continue;
        }
        const low = trim.toLowerCase();
        if (!seen.has(low)) {
          seen.set(low, trim);
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

async function applyWorkspacesTreeFilterChrome(
  treeView: vscode.TreeView<SyncTreeElement>,
  provider: WorkspacesTreeProvider,
): Promise<void> {
  const q = provider.getNoteFilter().trim();
  const tags = [...provider.getTagFilters()];
  const parts: string[] = [];
  if (q.length > 0) {
    const short = q.length > 36 ? `${q.slice(0, 33)}…` : q;
    parts.push(`🔍 ${short}`);
  }
  if (tags.length > 0) {
    parts.push(tags.map((t) => `#${t.replace(/\s+/g, "_")}`).join(" "));
  }
  if (provider.getShowArchived()) {
    parts.push("+archived");
  }
  const desc = parts.join(" · ");
  treeView.description = desc.length > 0 ? desc.slice(0, 120) : undefined;
  await vscode.commands.executeCommand(
    "setContext",
    "vscodesync.workspacesFilterActive",
    q.length > 0 || tags.length > 0,
  );
}

function roots(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

function pickRoot(): string | undefined {
  return resolveDefaultWorkspaceRootFsPath();
}

async function ensureProvider(
  registry: ProviderRegistry,
  globalConfig: GlobalConfigManager,
): Promise<ICloudProvider | null> {
  let cfg = await globalConfig.load();
  if (!cfg.activeProvider) {
    await globalConfig.set("activeProvider", "onedrive");
    await globalConfig.save();
    cfg = await globalConfig.load();
  }
  const p = await registry.getActive();
  if (!p) {
    await vscode.window.showErrorMessage("VSCodeSync: нет активного провайдера в реестре.");
    return null;
  }
  if (p instanceof OneDriveProvider && !(await p.isAuthenticated())) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: OneDrive не авторизован. Sign in to OneDrive или выберите другой провайдер.",
    );
  }
  if (p instanceof GdriveProvider && !(await p.isAuthenticated())) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: Google Drive не авторизован. Sign in to Google Drive или выберите другой провайдер.",
    );
  }
  if (p instanceof DropboxProvider && !(await p.isAuthenticated())) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: Dropbox не авторизован. Sign in to Dropbox или выберите другой провайдер.",
    );
  }
  if (p instanceof YandexDiskProvider && !(await p.isAuthenticated())) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: Яндекс Диск не авторизован. Sign in to Yandex Disk или выберите другой провайдер.",
    );
  }
  return p;
}

async function tryAuthenticatedProvider(registry: ProviderRegistry): Promise<ICloudProvider | null> {
  const p = await registry.getActive();
  if (!p) {
    return null;
  }
  try {
    return (await p.isAuthenticated()) ? p : null;
  } catch {
    return null;
  }
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

async function pickWorkspaceId(root: string): Promise<string | undefined> {
  const wc = await WorkspaceConfigManager.load(root);
  if (wc.activeWorkspaces.length === 0) {
    await vscode.window.showErrorMessage("Нет активных workspace — Create Workspace.");
    return undefined;
  }
  if (wc.activeWorkspaces.length === 1) {
    return wc.activeWorkspaces[0]?.workspaceId;
  }
  const picked = await vscode.window.showQuickPick(
    wc.activeWorkspaces.map((e) => ({
      label: `${e.workspaceNote} (${e.workspaceId})`,
      id: e.workspaceId,
    })),
    { placeHolder: "Выберите workspace" },
  );
  return picked?.id;
}

async function pickWorkspaceIdMatching(
  root: string,
  predicate: (e: ActiveWorkspaceEntry) => boolean,
  emptyWarn: string,
): Promise<string | undefined> {
  const wc = await WorkspaceConfigManager.load(root);
  const candidates = wc.activeWorkspaces.filter(predicate);
  if (candidates.length === 0) {
    await vscode.window.showWarningMessage(emptyWarn);
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0]?.workspaceId;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((e) => ({
      label: `${e.workspaceNote} (${e.workspaceId})`,
      id: e.workspaceId,
    })),
    { placeHolder: "Выберите workspace" },
  );
  return picked?.id;
}

async function pickOtherWorkspaceId(root: string, excludeWorkspaceId: string): Promise<string | undefined> {
  const wc = await WorkspaceConfigManager.load(root);
  const candidates = wc.activeWorkspaces.filter((w) => w.workspaceId !== excludeWorkspaceId);
  if (candidates.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: нет другого workspace для перемещения.");
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0]?.workspaceId;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((e) => ({
      label: `${e.workspaceNote} (${e.workspaceId})`,
      id: e.workspaceId,
    })),
    { placeHolder: "Переместить в workspace" },
  );
  return picked?.id;
}

async function resolveFileTarget(
  uri: vscode.Uri | undefined,
): Promise<{ root: string; fsPath: string } | undefined> {
  let u = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (u?.scheme !== "file") {
    // No active editor (e.g. called from webview) — show file picker
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: "Выбрать файл или папку",
      title: "VSCodeSync: выберите файл или папку",
    });
    u = picked?.[0];
    if (u?.scheme !== "file") {
      return undefined;
    }
  }
  const folder = vscode.workspace.getWorkspaceFolder(u);
  if (!folder) {
    await vscode.window.showWarningMessage("VSCodeSync: файл вне открытой папки workspace.");
    return undefined;
  }
  return { root: folder.uri.fsPath, fsPath: u.fsPath };
}

/** Command handler may receive a `Uri`, nothing (active editor), or a tree `SyncTreeElement`. */
async function resolveFileTargetLoose(
  globalConfig: GlobalConfigManager,
  arg?: unknown,
): Promise<{ root: string; fsPath: string } | undefined> {
  if (arg && typeof arg === "object" && "kind" in arg && (arg as SyncTreeElement).kind === "file") {
    const el = arg as SyncTreeElement & { kind: "file" };
    const wc = await WorkspaceConfigManager.load(el.folderRoot.fsPath);
    const gc = await globalConfig.load();
    const fsPath = trackedLocalAbsolutePath(el.folderRoot.fsPath, wc.pathMapping, gc.machineName, el.localPath);
    return { root: el.folderRoot.fsPath, fsPath };
  }
  if (arg instanceof vscode.Uri) {
    return resolveFileTarget(arg);
  }
  return resolveFileTarget(undefined);
}

function historyVersionLabel(meta: { cloudPath: string; modifiedIso?: string }): string {
  if (meta.modifiedIso) {
    try {
      return new Date(meta.modifiedIso).toLocaleString(vscode.env.language);
    } catch {
      /* ignore */
    }
  }
  const i = meta.cloudPath.lastIndexOf("/");
  return i >= 0 ? meta.cloudPath.slice(i + 1) : meta.cloudPath;
}

async function runShowFileHistory(
  runWithEngine: (
    fn: (engine: SyncEngine, root: string, gc: GlobalConfigManager) => Promise<void>,
    workspaceRoot?: string,
  ) => Promise<void>,
  globalConfig: GlobalConfigManager,
  target: { root: string; fsPath: string },
): Promise<void> {
  const gc = await globalConfig.load();
  const cfg0 = await WorkspaceConfigManager.load(target.root);
  let rel: string;
  try {
    rel = absoluteToTrackedPosix(target.root, cfg0.pathMapping, gc.machineName, target.fsPath);
  } catch {
    await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
    return;
  }
  if (!cfg0.files.some((f) => f.localPath === rel)) {
    await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
    return;
  }
  await runWithEngine(async (engine) => {
    const items = await engine.listCloudHistoryForTrackedFile(rel);
    // Also include local backups from .vscode/vscodesync-local-backup/
    const localBackupDir = path.join(target.root, ".vscode", "vscodesync-local-backup");
    const localBackups: { label: string; fsPath: string }[] = [];
    try {
      const timestamps = await fs.readdir(localBackupDir);
      for (const ts of timestamps.sort().reverse()) {
        const backupPath = path.join(localBackupDir, ts, ...rel.split("/"));
        try {
          await fs.access(backupPath);
          const dateStr = ts.replace(/T/, " ").replace(/\.\d+Z/, "").replace(/-/g, "/").replace(/\//g, "/");
          localBackups.push({ label: `📁 local backup · ${dateStr}`, fsPath: backupPath });
        } catch {
          // backup doesn't include this file
        }
      }
    } catch {
      // no backup dir
    }

    if (items.length === 0 && localBackups.length === 0) {
      await vscode.window.showInformationMessage(
        "VSCodeSync: в облаке нет снимков истории для этого файла. Они появляются после успешного push.",
      );
      return;
    }
    type HistPick = vscode.QuickPickItem & { cloudPath?: string; localFsPath?: string };
    const cloudItems: HistPick[] = items.map((m) => ({
      label: historyVersionLabel(m),
      description: m.cloudPath.includes("/") ? m.cloudPath.split("/").pop() : m.cloudPath,
      cloudPath: m.cloudPath,
    }));
    const localItems: HistPick[] = localBackups.map((b) => ({
      label: b.label,
      localFsPath: b.fsPath,
    }));
    const picked = await vscode.window.showQuickPick<HistPick>(
      [...localItems, ...cloudItems],
      { placeHolder: "Версия файла (local backup / облачная история)" },
    );
    if (!picked) {
      return;
    }
    const action = await vscode.window.showQuickPick(
      [
        { label: "Открыть", value: "open" as const },
        { label: "Сравнить с локальным файлом", value: "diff" as const },
      ],
      { placeHolder: "Действие" },
    );
    if (!action) {
      return;
    }
    let tmpUri: vscode.Uri;
    if (picked.localFsPath) {
      tmpUri = vscode.Uri.file(picked.localFsPath);
    } else if (picked.cloudPath) {
      const body = await engine.downloadHistorySnapshotIfOwned(rel, picked.cloudPath);
      const tmp = path.join(
        os.tmpdir(),
        `vscodesync-history-${String(Date.now())}-${path.basename(target.fsPath)}`,
      );
      await fs.writeFile(tmp, body);
      tmpUri = vscode.Uri.file(tmp);
    } else {
      return;
    }
    const localUri = vscode.Uri.file(target.fsPath);
    if (action.value === "open") {
      await vscode.window.showTextDocument(tmpUri);
    } else {
      const title = `${path.basename(target.fsPath)} (локально ↔ история)`;
      await vscode.commands.executeCommand("vscode.diff", localUri, tmpUri, title);
    }
  }, target.root);
}

/**
 * 3-way conflict diff:
 * - Downloads latest `.history/` version as `base` (common ancestor)
 * - Downloads current cloud version as `remote`
 * - Opens two diffs: base↔local ("your changes") and base↔remote ("cloud changes")
 * - If no history: falls back to 2-way diff local↔cloud
 */
async function runConflict3WayDiff(
  runWithEngine: (
    fn: (engine: SyncEngine, root: string, gc: GlobalConfigManager) => Promise<void>,
    workspaceRoot?: string,
  ) => Promise<void>,
  target: { root: string; fsPath: string },
): Promise<void> {
  await runWithEngine(async (engine) => {
    const basename = path.basename(target.fsPath);
    const posixRel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
    const localUri = vscode.Uri.file(target.fsPath);

    // Download remote (cloud) version
    let remoteTmp: string | undefined;
    try {
      const { body } = await engine.downloadTrackedBlob(posixRel);
      remoteTmp = path.join(os.tmpdir(), `vscodesync-remote-${String(Date.now())}-${basename}`);
      await fs.writeFile(remoteTmp, body);
    } catch {
      // fallback: can't get cloud version
    }

    // Try to get base from .history/
    let baseTmp: string | undefined;
    try {
      const histItems = await engine.listCloudHistoryForTrackedFile(posixRel);
      if (histItems.length > 0 && histItems[0]) {
        const baseBody = await engine.downloadHistorySnapshotIfOwned(posixRel, histItems[0].cloudPath);
        baseTmp = path.join(os.tmpdir(), `vscodesync-base-${String(Date.now())}-${basename}`);
        await fs.writeFile(baseTmp, baseBody);
      }
    } catch {
      // No history available
    }

    if (baseTmp && remoteTmp) {
      const baseUri = vscode.Uri.file(baseTmp);
      const remoteUri = vscode.Uri.file(remoteTmp);
      // Show two diffs side by side
      await vscode.commands.executeCommand(
        "vscode.diff",
        baseUri,
        localUri,
        `${basename}: ваши изменения (история → локально)`,
      );
      await vscode.commands.executeCommand(
        "vscode.diff",
        baseUri,
        remoteUri,
        `${basename}: облачные изменения (история → облако)`,
        { viewColumn: vscode.ViewColumn.Beside },
      );
      void vscode.window.showInformationMessage(
        `VSCodeSync: слева — ваши изменения (история → локально), справа — облачные изменения (история → облако). Используйте Keep Mine или Take Theirs для разрешения.`,
      );
    } else if (remoteTmp) {
      // Fallback: 2-way diff
      const remoteUri = vscode.Uri.file(remoteTmp);
      await vscode.commands.executeCommand(
        "vscode.diff",
        localUri,
        remoteUri,
        `${basename}: локально ↔ облако`,
      );
      void vscode.window.showInformationMessage(
        `VSCodeSync: история недоступна — показан 2-way diff. Используйте Keep Mine или Take Theirs.`,
      );
    } else {
      // No cloud version either
      await vscode.commands.executeCommand("vscodesync.diffWithCloud", localUri);
    }
  }, target.root);
}

/**
 * AI-assisted merge for a conflicting file.
 * 1. Downloads remote (cloud) version.
 * 2. Gets base from .history/ (common ancestor).
 * 3. Reads local version from disk.
 * 4. Calls runAiMerge; on success writes merged content and resolves via keepMine.
 * Returns true when conflict was resolved, false when skipped/failed.
 */
async function runAiMergeForConflict(
  runWithEngine: (
    fn: (engine: SyncEngine, root: string, gc: GlobalConfigManager) => Promise<void>,
    workspaceRoot?: string,
  ) => Promise<void>,
  target: { root: string; fsPath: string },
  workspaceId: string,
  posixRel: string,
  notifiedConflictKeys: Set<string>,
): Promise<boolean> {
  let resolved = false;

  await runWithEngine(async (engine) => {
    const basename = path.basename(target.fsPath);

    // Download cloud (remote) version
    let remoteText: string | undefined;
    try {
      const { body } = await engine.downloadTrackedBlob(posixRel);
      remoteText = body.toString("utf8");
    } catch {
      await vscode.window.showWarningMessage(
        "VSCodeSync AI Merge: не удалось скачать облачную версию.",
      );
      return;
    }

    // Read local version
    let localText: string;
    try {
      localText = await fs.readFile(target.fsPath, "utf8");
    } catch {
      await vscode.window.showWarningMessage(
        "VSCodeSync AI Merge: не удалось прочитать локальный файл.",
      );
      return;
    }

    // Get base from .history/ (may be absent — empty string as fallback)
    let baseText = "";
    try {
      const histItems = await engine.listCloudHistoryForTrackedFile(posixRel);
      if (histItems.length > 0 && histItems[0]) {
        const baseBody = await engine.downloadHistorySnapshotIfOwned(posixRel, histItems[0].cloudPath);
        baseText = baseBody.toString("utf8");
      }
    } catch {
      /* history unavailable — use empty base (effectively 2-way merge) */
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `VSCodeSync: AI merge «${basename}»…`, cancellable: false },
      async () => {
        const result = await runAiMerge(baseText, localText, remoteText, posixRel);

        if (!result.ok) {
          const reasonMsg: Record<string, string> = {
            disabled: "AI merge отключён (vscodesync.aiMerge: false).",
            no_model: "Нет доступной языковой модели. Активируйте GitHub Copilot.",
            too_large: result.detail ?? "Файл слишком большой для AI merge.",
            model_refused: result.detail ?? "Модель не смогла разрешить конфликт. Разрешите вручную.",
            error: result.detail ?? "Ошибка AI merge.",
          };
          await vscode.window.showWarningMessage(
            `VSCodeSync AI Merge: ${reasonMsg[result.reason]}`,
          );
          return;
        }

        // Write merged content to disk
        await fs.writeFile(target.fsPath, result.merged, "utf8");

        // Resolve conflict: keepMine (push the AI-merged version)
        await engine.resolveConflictKeepMine(workspaceId, posixRel);
        notifiedConflictKeys.delete(`${workspaceId}:${posixRel}`);
        resolved = true;

        await vscode.window.showInformationMessage(
          `✨ VSCodeSync: конфликт «${basename}» разрешён через AI. Версия запушена на облако.`,
        );
      },
    );
  }, target.root);

  return resolved;
}

async function openTrackedFileInCloudStorage(
  registry: ProviderRegistry,
  globalConfig: GlobalConfigManager,
  target: { root: string; fsPath: string },
): Promise<void> {
  const gc = await globalConfig.load();
  const cfg0 = await WorkspaceConfigManager.load(target.root);
  let rel: string;
  try {
    rel = absoluteToTrackedPosix(target.root, cfg0.pathMapping, gc.machineName, target.fsPath);
  } catch {
    await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
    return;
  }
  const fileEntry = cfg0.files.find((f) => f.localPath === rel);
  if (!fileEntry) {
    await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
    return;
  }
  const provider = await ensureProvider(registry, globalConfig);
  if (!provider) {
    return;
  }
  if (!provider.getWebViewLink) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: веб-ссылка для этого провайдера не поддерживается.",
    );
    return;
  }
  try {
    const url = await provider.getWebViewLink(fileEntry.cloudPath);
    if (!url) {
      await vscode.window.showWarningMessage("VSCodeSync: файл не найден в облаке или ссылка недоступна.");
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(`VSCodeSync: не удалось открыть облако — ${msg}`);
  }
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
    // Feed into conflict heatmap (file-level — line ranges aren't surfaced
    // by the resolve commands; the helper clusters by overlapping ranges so
    // sentinel 1..1 collapses to "file-level entry").
    if (ev.kind === "resolve_keep_mine" || ev.kind === "resolve_take_theirs") {
      void (async () => {
        try {
          const { recordConflictResolution } = await import("./ui/conflictHeatmapStoreFs.js");
          await recordConflictResolution(globalConfig.getStorageDir(), ev.relPath);
        } catch { /* heatmap is best-effort; silent on I/O errors */ }
      })();
    }
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
  const oneDriveOutputChannel = vscode.window.createOutputChannel("VSCodeSync · OneDrive");
  context.subscriptions.push(oneDriveOutputChannel);
  const googleDriveOutputChannel = vscode.window.createOutputChannel("VSCodeSync · Google Drive");
  context.subscriptions.push(googleDriveOutputChannel);
  const dropboxOutputChannel = vscode.window.createOutputChannel("VSCodeSync · Dropbox");
  context.subscriptions.push(dropboxOutputChannel);
  const yandexOutputChannel = vscode.window.createOutputChannel("VSCodeSync · Yandex Disk");
  context.subscriptions.push(yandexOutputChannel);
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
  const runAddToNewWorkspace = async (uri?: vscode.Uri, allUris?: vscode.Uri[]): Promise<void> => {
    const selectedUris =
      Array.isArray(allUris) && allUris.length > 1
        ? allUris
        : uri
          ? [uri]
          : undefined;

    const target = await resolveFileTarget(selectedUris?.[0] ?? uri);
    if (!target) {
      return;
    }

    const underRoot = (p: string): boolean => {
      const rel = path.relative(target.root, p);
      return rel !== ".." && !rel.startsWith(`..${path.sep}`);
    };

    const rawPaths: string[] = selectedUris
      ? selectedUris.map((u) => u.fsPath).filter((p) => underRoot(p))
      : [target.fsPath];

    const note =
      (await vscode.window.showInputBox({
        title: "VSCodeSync: новый workspace",
        prompt: "Будет создан воркспейс и в него добавлены выбранные файлы или содержимое папки",
        placeHolder: "Название / описание воркспейса",
      }))?.trim() ?? "";
    if (!note) {
      return;
    }

    await runWithEngine(async (engine, root, gc) => {
      const cfgProv = await gc.load();
      const t = cfgProv.activeProvider ?? "onedrive";
      try {
        const existing = await engine.listRemoteWorkspaceSummaries();
        const duplicate = existing.find(
          (w) => w.workspaceNote.trim().toLowerCase() === note.trim().toLowerCase(),
        );
        if (duplicate) {
          const proceed = await vscode.window.showWarningMessage(
            `VSCodeSync: workspace с названием «${duplicate.workspaceNote}» уже существует в облаке (${duplicate.workspaceId}). Создать ещё один?`,
            { modal: true },
            "Создать",
          );
          if (proceed !== "Создать") {
            return;
          }
        }
      } catch {
        /* non-fatal: listing may fail */
      }

      const wid = await engine.createWorkspace(note, t);
      const wc = await WorkspaceConfigManager.load(root);
      const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wid);
      if (!ent) {
        throw new Error("VSCodeSync: запись workspace не найдена после создания");
      }
      const gconf = await gc.load();

      let selectionHadDirectory = false;
      for (const p of rawPaths) {
        try {
          const st = await fs.stat(p);
          if (st.isDirectory()) {
            selectionHadDirectory = true;
          }
        } catch {
          /* ignore */
        }
      }

      const expanded = await collectFilesToAddUnderRoots(target.root, rawPaths, {
        entry: ent,
        cfg: wc,
        machineName: gconf.machineName,
      });
      if (expanded.length === 0) {
        await vscode.window.showInformationMessage(
          `VSCodeSync: воркспейс «${note}» создан. Нечего добавить (пусто или всё в правилах исключения).`,
        );
        return;
      }
      if (expanded.length > 500) {
        const big = await vscode.window.showWarningMessage(
          `VSCodeSync: будет добавлено ${String(expanded.length)} файлов. Продолжить?`,
          { modal: true },
          "Продолжить",
        );
        if (big !== "Продолжить") {
          await vscode.window.showInformationMessage(
            `VSCodeSync: воркспейс «${note}» создан без файлов (операция отменена).`,
          );
          return;
        }
      }
      const useBulkAddConfirm = expanded.length > 1 || selectionHadDirectory;
      if (useBulkAddConfirm) {
        const ok = await vscode.window.showInformationMessage(
          `Новый воркспейс «${note}»: добавить ${String(expanded.length)} файл(ов) и синхронизировать?`,
          { modal: true },
          "Добавить",
        );
        if (ok !== "Добавить") {
          await vscode.window.showInformationMessage(
            `VSCodeSync: воркспейс «${note}» создан; файлы не добавлены.`,
          );
          return;
        }
      }
      const withPreview = !useBulkAddConfirm;
      if (
        !(await guardPathsBeforeAdd(expanded, withPreview, target.root, {
          entry: ent,
          cfg: wc,
          machineName: gconf.machineName,
        }))
      ) {
        await vscode.window.showInformationMessage(
          `VSCodeSync: воркспейс «${note}» создан; добавление файлов отменено.`,
        );
        return;
      }
      await engine.addFiles(wid, expanded);
      if (expanded.length === 1) {
        await vscode.window.showInformationMessage(`Воркспейс «${note}» создан; файл синхронизирован.`);
      } else {
        await vscode.window.showInformationMessage(
          `Воркспейс «${note}» создан; ${String(expanded.length)} файлов синхронизировано.`,
        );
      }
    }, target.root);
  };

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

  // Custom collapse all (built-in disabled to control toolbar position)
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.collapseAllWorkspaces", () => {
      // `collapseAll` exists at runtime but is missing from older @types/vscode.
      const v = treeView as unknown as { collapseAll?: () => Thenable<void> };
      void v.collapseAll?.();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.showSyncDashboard", async () => {
      await statusBar.showDashboard();
    }),

    vscode.commands.registerCommand("vscodesync.focusWorkspacesView", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.vscodesync.focus");
    }),

    vscode.commands.registerCommand("vscodesync.refreshWorkspacesView", () => {
      workspacesTree.invalidateRemoteCache();
      workspacesTree.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.filterWorkspaces", () => {
      if (workspacesFilterInputBox) {
        workspacesFilterInputBox.show();
        return;
      }
      const ib = vscode.window.createInputBox();
      workspacesFilterInputBox = ib;
      ib.title = "VSCodeSync: фильтр Workspaces";
      ib.placeholder = "По заметке или ID workspace";
      ib.value = workspacesTree.getNoteFilter();
      let debounce: ReturnType<typeof setTimeout> | undefined;
      ib.onDidChangeValue((v) => {
        if (debounce !== undefined) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
          debounce = undefined;
          const trimmed = v.trim();
          workspacesTree.setNoteFilter(v);
          void context.globalState.update(WORKSPACES_NOTE_FILTER_KEY, trimmed);
          void applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
        }, 120);
      });
      ib.onDidAccept(() => {
        ib.hide();
      });
      ib.onDidHide(() => {
        if (debounce !== undefined) {
          clearTimeout(debounce);
        }
        workspacesFilterInputBox = undefined;
        ib.dispose();
      });
      ib.show();
    }),

    vscode.commands.registerCommand("vscodesync.clearWorkspacesFilter", async () => {
      workspacesTree.setNoteFilter("");
      workspacesTree.setTagFilters([]);
      await context.globalState.update(WORKSPACES_NOTE_FILTER_KEY, "");
      await context.globalState.update(WORKSPACES_TAG_FILTERS_KEY, []);
      await applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
    }),

    vscode.commands.registerCommand("vscodesync.pickWorkspaceTagFilters", async () => {
      const allTags = await collectAllWorkspaceTags();
      if (allTags.length === 0) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: в локальном кэше нет тегов. Выполните sync / Repair State или задайте теги для workspace.",
        );
        return;
      }
      const current = new Set(workspacesTree.getTagFilters().map((t) => t.trim().toLowerCase()));
      const picked = await vscode.window.showQuickPick(
        allTags.map((label) => ({ label, picked: current.has(label.trim().toLowerCase()) })),
        { canPickMany: true, title: "VSCodeSync: фильтр тегов (все выбранные — AND)" },
      );
      if (picked === undefined) {
        return;
      }
      workspacesTree.setTagFilters(picked.map((p) => p.label));
      await context.globalState.update(WORKSPACES_TAG_FILTERS_KEY, [...workspacesTree.getTagFilters()]);
      await applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
    }),

    vscode.commands.registerCommand("vscodesync.toggleShowArchivedWorkspaces", async () => {
      workspacesTree.setShowArchived(!workspacesTree.getShowArchived());
      await context.globalState.update(WORKSPACES_SHOW_ARCHIVED_KEY, workspacesTree.getShowArchived());
      await applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
    }),

    vscode.commands.registerCommand("vscodesync.setNotificationLevel", async () => {
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const cur = cfg.get<string>("notificationLevel", "normal");
      const picked = await vscode.window.showQuickPick(
        [
          { label: "minimal", description: "Только ошибки", value: "minimal" as const },
          { label: "normal", description: "Стандартные уведомления", value: "normal" as const },
          { label: "verbose", description: "Подробные сообщения", value: "verbose" as const },
        ],
        { placeHolder: `Сейчас: ${cur}` },
      );
      if (!picked) {
        return;
      }
      await cfg.update("notificationLevel", picked.value, vscode.ConfigurationTarget.Global);
      await vscode.window.showInformationMessage(`VSCodeSync: уровень уведомлений — ${picked.label}`);
    }),
  );

  const runOneDriveAuth = async (openBrowser: boolean): Promise<void> => {
    const clientId = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("onedriveClientId", "");
    if (!clientId) {
      await vscode.window.showErrorMessage("Задайте vscodesync.onedriveClientId в настройках.");
      return;
    }
    oneDriveOutputChannel.clear();
    oneDriveOutputChannel.show(true);
    try {
      await runOneDriveDeviceCodeLogin(context.secrets, clientId, (uri, userCode, msg) => {
        oneDriveOutputChannel.appendLine(msg);
        oneDriveOutputChannel.appendLine("");
        oneDriveOutputChannel.appendLine("Verification URL:");
        oneDriveOutputChannel.appendLine(uri);
        oneDriveOutputChannel.appendLine("");
        oneDriveOutputChannel.appendLine(`User code: ${userCode}`);
        if (openBrowser) {
          void vscode.window.showInformationMessage(msg);
          void vscode.env.openExternal(vscode.Uri.parse(uri));
        } else {
          void vscode.window.showInformationMessage(
            "OneDrive Device Code: откройте URL из панели Output (VSCodeSync · OneDrive), например в браузере на другой машине, и введите код.",
          );
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      oneDriveOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(`OneDrive: ${msg}`);
      return;
    }
    await globalConfig.set("activeProvider", "onedrive");
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider("onedrive");
    refreshCloudWebhooks();
    await vscode.window.showInformationMessage("OneDrive: токены сохранены.");
    await statusBar.refresh();
    workspacesTree.refresh();
    fileDecorations.refresh();
    void refreshActiveEditorSyncContext();
  };

  const runGoogleDriveAuth = async (openBrowser: boolean): Promise<void> => {
    const clientId = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("googleDriveClientId", "");
    if (!clientId) {
      await vscode.window.showErrorMessage("Задайте vscodesync.googleDriveClientId в настройках.");
      return;
    }
    googleDriveOutputChannel.clear();
    googleDriveOutputChannel.show(true);
    try {
      await runGoogleDriveDeviceCodeLogin(context.secrets, clientId, (uri, userCode, msg) => {
        googleDriveOutputChannel.appendLine(msg);
        googleDriveOutputChannel.appendLine("");
        googleDriveOutputChannel.appendLine("Verification URL:");
        googleDriveOutputChannel.appendLine(uri);
        googleDriveOutputChannel.appendLine("");
        googleDriveOutputChannel.appendLine(`User code: ${userCode}`);
        if (openBrowser) {
          void vscode.window.showInformationMessage(msg);
          void vscode.env.openExternal(vscode.Uri.parse(uri));
        } else {
          void vscode.window.showInformationMessage(
            "Google Drive Device Code: откройте URL из панели Output (VSCodeSync · Google Drive), например в браузере на другой машине, и введите код.",
          );
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      googleDriveOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(`Google Drive: ${msg}`);
      return;
    }
    await globalConfig.set("activeProvider", "gdrive");
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider("gdrive");
    await vscode.window.showInformationMessage("Google Drive: токены сохранены.");
    await statusBar.refresh();
    workspacesTree.refresh();
    fileDecorations.refresh();
    void refreshActiveEditorSyncContext();
    refreshCloudWebhooks();
  };

  const runDropboxAuth = async (openBrowser: boolean): Promise<void> => {
    const appKey = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("dropboxAppKey", "");
    if (!appKey) {
      await vscode.window.showErrorMessage(
        `Задайте vscodesync.dropboxAppKey в настройках. Redirect URI в Dropbox Console: ${DROPBOX_OAUTH_REDIRECT_URI}`,
      );
      return;
    }
    dropboxOutputChannel.clear();
    dropboxOutputChannel.show(true);
    dropboxOutputChannel.appendLine(`OAuth redirect (must match Dropbox app): ${DROPBOX_OAUTH_REDIRECT_URI}`);
    dropboxOutputChannel.appendLine("");
    try {
      await runDropboxOAuthLoopback(context.secrets, appKey, (authUrl: string) => {
        dropboxOutputChannel.appendLine("Authorization URL:");
        dropboxOutputChannel.appendLine(authUrl);
        dropboxOutputChannel.appendLine("");
        if (openBrowser) {
          void vscode.window.showInformationMessage("Откройте браузер для входа в Dropbox (URL также в Output).");
          void vscode.env.openExternal(vscode.Uri.parse(authUrl));
        } else {
          void vscode.window.showInformationMessage(
            "Dropbox OAuth: откройте URL из панели Output (VSCodeSync · Dropbox).",
          );
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dropboxOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(`Dropbox: ${msg}`);
      return;
    }
    await globalConfig.set("activeProvider", "dropbox");
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider("dropbox");
    await vscode.window.showInformationMessage("Dropbox: токены сохранены.");
    await statusBar.refresh();
    workspacesTree.refresh();
    fileDecorations.refresh();
    void refreshActiveEditorSyncContext();
    refreshCloudWebhooks();
  };

  const runYandexDiskAuth = async (openBrowser: boolean): Promise<void> => {
    const yandexCfg = vscode.workspace.getConfiguration(CFG_SECTION);
    const clientId = yandexCfg.get<string>("yandexOAuthClientId", "");
    const useAppFolder = yandexCfg.get<boolean>("yandexUseAppFolder", false);
    if (!clientId) {
      await vscode.window.showErrorMessage(
        `Задайте vscodesync.yandexOAuthClientId в настройках. Redirect URI в Яндекс OAuth: ${YANDEX_OAUTH_REDIRECT_URI}`,
      );
      return;
    }
    yandexOutputChannel.clear();
    yandexOutputChannel.show(true);
    yandexOutputChannel.appendLine(`OAuth redirect (должен совпадать с приложением Яндекса): ${YANDEX_OAUTH_REDIRECT_URI}`);
    if (useAppFolder) {
      yandexOutputChannel.appendLine("Режим: папка приложения (scope: cloud_api:disk.app_folder)");
    }
    yandexOutputChannel.appendLine("");
    try {
      await runYandexOAuthLoopback(context.secrets, clientId, (authUrl: string) => {
        yandexOutputChannel.appendLine("Authorization URL:");
        yandexOutputChannel.appendLine(authUrl);
        yandexOutputChannel.appendLine("");
        if (openBrowser) {
          void vscode.window.showInformationMessage("Откройте браузер для входа в Яндекс (URL также в Output).");
          void vscode.env.openExternal(vscode.Uri.parse(authUrl));
        } else {
          void vscode.window.showInformationMessage(
            "Yandex OAuth: откройте URL из панели Output (VSCodeSync · Yandex Disk).",
          );
        }
      }, useAppFolder);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      yandexOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(`Yandex Disk: ${msg}`);
      return;
    }
    await globalConfig.set("activeProvider", "yandex");
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider("yandex");
    await vscode.window.showInformationMessage("Яндекс Диск: токены сохранены.");
    await statusBar.refresh();
    workspacesTree.refresh();
    fileDecorations.refresh();
    void refreshActiveEditorSyncContext();
    refreshCloudWebhooks();
  };

  registerProviderMigrationCommand(context, {
    registry,
    globalConfig,
    workspacesTree,
    makeEngine,
    signInOneDrive: () => runOneDriveAuth(true),
    signInGoogleDrive: () => runGoogleDriveAuth(true),
    signInDropbox: () => runDropboxAuth(true),
    signInYandexDisk: () => runYandexDiskAuth(true),
    refreshUi: async () => {
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
      refreshCloudWebhooks();
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscodesync.treeWorkspacePushAll",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        await runWithEngine(async (engine) => {
          const proceed = await confirmTreeWorkspaceBulkSyncIfNeeded(
            engine,
            syncPreviewChannel,
            el.workspaceId,
            el.note || el.workspaceId,
            "push",
          );
          if (!proceed) {
            return;
          }
          await engine.pushAll(el.workspaceId);
          await vscode.window.showInformationMessage(`Push workspace (${el.note}): готово.`);
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspacePullAll",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        await runWithEngine(async (engine) => {
          const proceed = await confirmTreeWorkspaceBulkSyncIfNeeded(
            engine,
            syncPreviewChannel,
            el.workspaceId,
            el.note || el.workspaceId,
            "pull",
          );
          if (!proceed) {
            return;
          }
          await engine.pullAll(el.workspaceId);
          await vscode.window.showInformationMessage(`Pull workspace (${el.note}): готово.`);
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceSync",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        await runWithEngine(async (engine) => {
          const proceed = await confirmTreeWorkspaceBulkSyncIfNeeded(
            engine,
            syncPreviewChannel,
            el.workspaceId,
            el.note || el.workspaceId,
            "sync",
          );
          if (!proceed) {
            return;
          }
          await engine.syncWorkspace(el.workspaceId);
          await vscode.window.showInformationMessage(`Sync (${el.note}): готово.`);
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceDetach",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        const ws = el.workspaceId;
        const confirm = await vscode.window.showWarningMessage(
          `Отключить «${el.note || ws}» только в этом проекте? Данные в облаке не удаляются.`,
          { modal: true },
          "Отключить",
        );
        if (confirm !== "Отключить") {
          return;
        }
        await runWithEngine(
          async (engine) => {
            await engine.detachWorkspaceLocal(ws);
            await vscode.window.showInformationMessage("Workspace отключён локально.");
          },
          rootPath,
        );
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceRenameNote",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const note =
          (await vscode.window.showInputBox({
            title: "VSCodeSync: имя workspace",
            value: el.note || el.workspaceId,
            validateInput: (v) => (v.trim() ? undefined : "Укажите непустое имя"),
          })) ?? "";
        if (!note.trim()) {
          return;
        }
        await runWithEngine(async (engine) => {
          await engine.renameWorkspaceNote(el.workspaceId, note.trim());
          await vscode.window.showInformationMessage("Название обновлено в облаке и локально.");
        }, el.folderRoot.fsPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceHealthCheck",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        const wc = await WorkspaceConfigManager.load(rootPath);
        const local = workspaceHealthFromLocalCfg(wc, el.workspaceId);
        await runWithEngine(async (engine) => {
          const r = await engine.healthCheckWorkspace(el.workspaceId);
          const cloudPart = r.ok ? "манифест OK" : `манифест: ${r.message}`;
          const lines: string[] = [
            "VSCodeSync Health Check",
            "",
            `${workspaceHealthEmoji(local.level)} ${el.note || el.workspaceId} — ${cloudPart}`,
          ];
          for (const s of local.summaryLines) {
            lines.push(`  · ${s}`);
          }
          await vscode.window.showInformationMessage(lines.join("\n"));
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeRemoteWorkspaceConnect",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "remoteOffer") {
          return;
        }
        workspacesTree.setWorkspaceLoading(el.workspaceId, true);
        workspacesTree.refresh(); // immediately show spinner; uses cached remote summaries, no network hit
        try {
          await runWithEngine(async (engine) => {
            await engine.attachCloudWorkspace(el.workspaceId);
            const label = el.workspaceNote.trim().length > 0 ? el.workspaceNote : el.workspaceId;
            await vscode.window.showInformationMessage(`VSCodeSync: подключён workspace «${label}» (${el.workspaceId})`);
          }, el.anchorFolder.fsPath);
          // Workspace moved from remote to local — invalidate so the section updates
          workspacesTree.invalidateRemoteCache();
          void (async () => {
            const { maybePromptPathMapperAfterAttach } = await import("./ui/aiPathMapperCommand.js");
            await maybePromptPathMapperAfterAttach(context, el.workspaceId);
          })();
        } finally {
          workspacesTree.setWorkspaceLoading(el.workspaceId, false);
          // runWithEngine's finally already calls workspacesTree.refresh() — it merges with any pending refresh
        }
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeRemoteWorkspaceDelete",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "remoteOffer") {
          return;
        }
        const label = el.workspaceNote.trim().length > 0 ? el.workspaceNote : el.workspaceId;
        const confirmed = await vscode.window.showWarningMessage(
          `Удалить workspace «${label}» (${el.workspaceId}) с облака?\n\nВсе файлы в VSCodeSyncFiles/${el.workspaceId}/ будут удалены без восстановления.`,
          { modal: true },
          "Удалить с облака",
        );
        if (confirmed !== "Удалить с облака") {
          return;
        }
        const provider = await ensureProvider(registry, globalConfig);
        if (!provider) {
          return;
        }
        const cfg = await globalConfig.load();
        const engine = makeEngine(
          el.anchorFolder.fsPath,
          provider,
          cfg.machineId,
          cfg.machineName,
        );
        try {
          await engine.deleteCloudFilesOnly(el.workspaceId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await vscode.window.showErrorMessage(
            `VSCodeSync: не удалось удалить workspace «${label}» с облака. Ошибка: ${msg}`,
          );
          return;
        }
        workspacesTree.invalidateRemoteCache();
        workspacesTree.refresh();
        await vscode.window.showInformationMessage(
          `VSCodeSync: workspace «${label}» (${el.workspaceId}) удалён с облака.`,
        );
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceShowMenu",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const isActive = !el.syncState || el.syncState === "active";
        const isSuspended = el.syncState === "suspended";
        const isFrozen = el.syncState === "frozen";
        const isArchived = el.tags.some((t) => t.trim().toLowerCase() === "archived");

        type MenuItem = vscode.QuickPickItem & { cmd: string; args?: unknown[] };
        const items: MenuItem[] = [];

        if (isActive) {
          items.push(
            { label: "$(cloud-upload) Push All", description: "Залить все файлы на облако", cmd: "vscodesync.treeWorkspacePushAll", args: [el] },
            { label: "$(cloud-download) Pull All", description: "Скачать все файлы с облака", cmd: "vscodesync.treeWorkspacePullAll", args: [el] },
            { label: "$(sync) Sync", description: "Push + Pull", cmd: "vscodesync.treeWorkspaceSync", args: [el] },
            { label: "", kind: vscode.QuickPickItemKind.Separator, cmd: "" },
          );
        }

        items.push(
          { label: "$(edit) Переименовать", description: "Изменить заметку", cmd: "vscodesync.treeWorkspaceRenameNote", args: [el] },
        );

        if (isActive && !isArchived) {
          items.push({ label: "$(archive) Архивировать", description: "Пометить тегом archived", cmd: "vscodesync.archiveWorkspace", args: [el] });
        }
        if (isArchived) {
          items.push({ label: "$(archive) Разархивировать", description: "Убрать тег archived", cmd: "vscodesync.unarchiveWorkspace", args: [el] });
        }
        if (isActive) {
          items.push({ label: "$(debug-pause) Приостановить", description: "Suspend — без push/pull", cmd: "vscodesync.suspendWorkspace", args: [el] });
        }
        if (isSuspended) {
          items.push({ label: "$(play) Возобновить", description: "Resume из Suspend", cmd: "vscodesync.resumeWorkspace", args: [el] });
        }
        if (isActive || isSuspended) {
          items.push({ label: "$(lock) Заморозить", description: "Freeze — только чтение облака", cmd: "vscodesync.freezeWorkspace", args: [el] });
        }
        if (isFrozen) {
          items.push({ label: "$(unlock) Разморозить", description: "Unfreeze", cmd: "vscodesync.unfreezeWorkspace", args: [el] });
        }

        items.push(
          { label: "", kind: vscode.QuickPickItemKind.Separator, cmd: "" },
          { label: "$(pulse) Health Check", description: "Проверить состояние", cmd: "vscodesync.treeWorkspaceHealthCheck", args: [el] },
          { label: "$(plug) Отвязать локально", description: "Detach — облако не трогать", cmd: "vscodesync.treeWorkspaceDetach", args: [el] },
          { label: "", kind: vscode.QuickPickItemKind.Separator, cmd: "" },
          { label: "$(trash) Удалить с облака", description: "Удалить workspace из облака без восстановления", cmd: "vscodesync.deleteWorkspaceFromCloud", args: [el] },
        );

        const picked = await vscode.window.showQuickPick(
          items.filter((i) => i.cmd !== "" || i.kind === vscode.QuickPickItemKind.Separator),
          { title: `Workspace: ${el.note || el.workspaceId}`, placeHolder: "Выберите действие" },
        );
        if (!picked?.cmd) {
          return;
        }
        await vscode.commands.executeCommand(picked.cmd, ...(picked.args ?? []));
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceAddTagToPanelFilter",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const tags = el.tags;
        if (tags.length === 0) {
          await vscode.window.showInformationMessage(
            "VSCodeSync: у workspace нет тегов в локальном кэше — sync или Repair State.",
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(tags, {
          title: "Добавить тег к фильтру панели (AND)",
        });
        if (!picked) {
          return;
        }
        const next = [...workspacesTree.getTagFilters()];
        const low = picked.trim().toLowerCase();
        if (!next.some((t) => t.trim().toLowerCase() === low)) {
          next.push(picked);
        }
        workspacesTree.setTagFilters(next);
        await context.globalState.update(WORKSPACES_TAG_FILTERS_KEY, [...workspacesTree.getTagFilters()]);
        await applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
      },
    ),

    vscode.commands.registerCommand("vscodesync.quickSwitchWorkspace", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      type Item = vscode.QuickPickItem & {
        folder: vscode.WorkspaceFolder;
        workspaceId: string;
        suspended: boolean;
        lastSync: string;
      };
      const items: Item[] = [];
      for (const folder of folders) {
        const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
        for (const aw of wc.activeWorkspaces) {
          const filesForWs = wc.files.filter((f) => f.workspaceId === aw.workspaceId);
          let last = "";
          for (const f of filesForWs) {
            if (f.lastSync && f.lastSync > last) last = f.lastSync;
          }
          const note = aw.workspaceNote || aw.workspaceId;
          const suspended = normalizeWorkspaceSyncState(aw) === "suspended";
          const icon = suspended ? "$(debug-pause)" : "$(cloud)";
          items.push({
            folder,
            workspaceId: aw.workspaceId,
            suspended,
            lastSync: last,
            label: `${icon} ${note}`,
            description: suspended ? "suspended" : "active",
            detail: `${folder.name} · ${String(filesForWs.length)} files${last ? ` · last sync ${last}` : ""}`,
          });
        }
      }
      if (items.length === 0) {
        await vscode.window.showInformationMessage(
          "VSCodeSync: в открытых папках нет подключённых workspace.",
        );
        return;
      }
      // Recent first
      items.sort((a, b) => (a.lastSync < b.lastSync ? 1 : a.lastSync > b.lastSync ? -1 : 0));
      const picked = await vscode.window.showQuickPick(items, {
        title: "VSCodeSync · быстрое переключение workspace",
        placeHolder: "Выберите workspace для просмотра / Resume / Suspend",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) return;
      // Focus the Workspaces view so the user lands in context. Resume of a
      // suspended workspace is one click away from there; we don't try to
      // synthesise a SyncTreeElement here because the view will rebuild it.
      await vscode.commands.executeCommand("vscodesync.focusWorkspacesView");
      if (picked.suspended) {
        await vscode.window.showInformationMessage(
          `«${picked.label.replace(/^\$\([^)]+\)\s*/, "")}» в режиме Suspend — нажмите Resume в дереве.`,
        );
      }
    }),

    vscode.commands.registerCommand("vscodesync.suspendWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        const wc = await WorkspaceConfigManager.load(root);
        const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
        if (
          !ent ||
          normalizeWorkspaceSyncState(ent) !== "active" ||
          hasArchivedTag(ent.tags)
        ) {
          await vscode.window.showWarningMessage(
            "VSCodeSync: Suspend только для активного workspace без archived.",
          );
          return;
        }
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => normalizeWorkspaceSyncState(e) === "active" && !hasArchivedTag(e.tags),
          "VSCodeSync: нет workspace в состоянии «активен» (без archived).",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const ws = wsId;
      const rt = root;
      await runWithEngine(
        async (engine) => {
          await engine.setWorkspaceSyncState(ws, "suspended");
          await vscode.window.showInformationMessage(
            "VSCodeSync: workspace приостановлен (Suspend) — push/pull файлов отключены; манифест можно обновлять.",
          );
        },
        rt,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.resumeWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        const wc = await WorkspaceConfigManager.load(root);
        const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
        if (!ent || normalizeWorkspaceSyncState(ent) !== "suspended" || hasArchivedTag(ent.tags)) {
          await vscode.window.showWarningMessage(
            "VSCodeSync: Resume только для workspace в Suspend (не archived — для разархивации: Unarchive).",
          );
          return;
        }
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => normalizeWorkspaceSyncState(e) === "suspended" && !hasArchivedTag(e.tags),
          "VSCodeSync: нет workspace в режиме Suspend (без archived).",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const ws = wsId;
      const rt = root;
      await runWithEngine(
        async (engine) => {
          await engine.setWorkspaceSyncState(ws, "active");
          await vscode.window.showInformationMessage("VSCodeSync: workspace снова активен (Resume).");
        },
        rt,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.archiveWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      let noteLabel: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        noteLabel = el.note || el.workspaceId;
        const wc = await WorkspaceConfigManager.load(root);
        const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
        if (
          !ent ||
          normalizeWorkspaceSyncState(ent) !== "active" ||
          hasArchivedTag(ent.tags)
        ) {
          await vscode.window.showWarningMessage(
            "VSCodeSync: архивировать можно только активный workspace без тега archived.",
          );
          return;
        }
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => normalizeWorkspaceSyncState(e) === "active" && !hasArchivedTag(e.tags),
          "VSCodeSync: нет подходящего workspace (нужен Active без archived).",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const lab = noteLabel ?? wsId;
      const confirm = await vscode.window.showWarningMessage(
        `Архивировать «${lab}»? Будут добавлен тег archived и режим Suspend; строка скроется из списка, пока не включён показ архивных.`,
        { modal: true },
        "Архивировать",
      );
      if (confirm !== "Архивировать") {
        return;
      }
      const ws = wsId;
      const rt = root;
      await runWithEngine(
        async (engine) => {
          await applyArchivedTagAndSuspend(engine, ws);
          await vscode.window.showInformationMessage(
            "VSCodeSync: workspace архивирован (archived + Suspend). Включите «Toggle Show Archived», чтобы видеть строку.",
          );
        },
        rt,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.unarchiveWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      let noteLabel: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        noteLabel = el.note || el.workspaceId;
        if (!hasArchivedTag(el.tags)) {
          await vscode.window.showWarningMessage(
            "VSCodeSync: разархивировать можно только workspace с тегом archived.",
          );
          return;
        }
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => hasArchivedTag(e.tags),
          "VSCodeSync: нет workspace с тегом archived.",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
      if (!ent) {
        await vscode.window.showWarningMessage("VSCodeSync: workspace не найден в vscodesync.json.");
        return;
      }
      const prior = normalizeWorkspaceSyncState(ent);
      const lab = noteLabel ?? (ent.workspaceNote.trim() ? ent.workspaceNote : wsId);
      await runWithEngine(
        async (engine) => {
          const proceed = await confirmTreeWorkspaceBulkSyncIfNeeded(
            engine,
            syncPreviewChannel,
            wsId,
            lab,
            "pull",
          );
          if (!proceed) {
            return;
          }
          await stripArchivedTagAndActivate(engine, wsId, prior);
          await engine.pullAll(wsId);
          await vscode.window.showInformationMessage("VSCodeSync: workspace разархивирован; Pull выполнен.");
        },
        root,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }),

    vscode.commands.registerCommand("vscodesync.freezeWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      let noteLabel: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        noteLabel = el.note || el.workspaceId;
        const wc = await WorkspaceConfigManager.load(root);
        const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
        const st = ent ? normalizeWorkspaceSyncState(ent) : "active";
        if (hasArchivedTag(ent?.tags)) {
          await vscode.window.showWarningMessage("VSCodeSync: сначала разархивируйте workspace (Unarchive).");
          return;
        }
        if (st === "frozen") {
          await vscode.window.showWarningMessage("VSCodeSync: workspace уже в Freeze.");
          return;
        }
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => {
            const st = normalizeWorkspaceSyncState(e);
            return (st === "active" || st === "suspended") && !hasArchivedTag(e.tags);
          },
          "VSCodeSync: нет подходящего workspace для Freeze.",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const lab = noteLabel ?? wsId;
      const confirm = await vscode.window.showWarningMessage(
        `Заморозить «${lab}» (Freeze)? Запись манифеста и файлов на облако будет заблокирована.`,
        { modal: true },
        "Freeze",
      );
      if (confirm !== "Freeze") {
        return;
      }
      const ws = wsId;
      const rt = root;
      await runWithEngine(
        async (engine) => {
          await engine.setWorkspaceSyncState(ws, "frozen");
          await vscode.window.showInformationMessage(
            "VSCodeSync: Freeze — без push/pull и без записи манифеста/_meta.",
          );
        },
        rt,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.unfreezeWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        const wc = await WorkspaceConfigManager.load(root);
        const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
        if (!ent || normalizeWorkspaceSyncState(ent) !== "frozen") {
          await vscode.window.showWarningMessage("VSCodeSync: Unfreeze только для workspace в Freeze.");
          return;
        }
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => normalizeWorkspaceSyncState(e) === "frozen",
          "VSCodeSync: нет workspace в режиме Freeze.",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const ws = wsId;
      const rt = root;
      await runWithEngine(async (engine) => {
        await engine.setWorkspaceSyncState(ws, "active");
        await engine.repairLocalStateFromCloud(ws);
        await engine.syncWorkspace(ws);
        await vscode.window.showInformationMessage(
          "VSCodeSync: Freeze снят — подтянуты метаданные с облака и выполнен sync workspace.",
        );
      }, rt);
      workspacesTree.refresh();
      await statusBar.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }),

    vscode.commands.registerCommand("vscodesync.deleteWorkspaceFromCloud", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      let noteLabel: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        noteLabel = el.note || el.workspaceId;
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceId(root);
        if (!wsId) {
          return;
        }
        const wc = await WorkspaceConfigManager.load(root);
        noteLabel = wc.activeWorkspaces.find((w) => w.workspaceId === wsId)?.workspaceNote ?? wsId;
      }
      if (!wsId || !root) {
        return;
      }
      const lab = noteLabel;
      const localFilesAction = await vscode.window.showWarningMessage(
        `Удалить workspace «${lab}» (${wsId}) с облака?\n\nВсе файлы в VSCodeSyncFiles/${wsId}/ будут удалены без восстановления.\nЧто делать с локальными копиями на этом компьютере?`,
        { modal: true },
        "Удалить с облака, локальные оставить",
        "Удалить с облака и удалить локально",
        "Только отвязать здесь",
      );
      if (!localFilesAction) {
        return;
      }
      const ws = wsId;
      const rt = root;
      await runWithEngine(
        async (engine) => {
          if (localFilesAction === "Только отвязать здесь") {
            await engine.detachWorkspaceLocal(ws);
            workspacesTree.refresh();
            await vscode.window.showInformationMessage(
              `VSCodeSync: workspace ${ws} отвязан локально. Облако и локальные файлы не тронуты.`,
            );
          } else if (localFilesAction === "Удалить с облака и удалить локально") {
            const wc = await WorkspaceConfigManager.load(rt);
            const savedEntry = wc.activeWorkspaces.find((e) => e.workspaceId === ws);
            const savedFiles = wc.files.filter((f) => f.workspaceId === ws);
            const localPaths = savedFiles.map((f) => path.join(rt, ...f.localPath.split("/")));

            // Optimistic hide: mark as pending-delete so the workspace disappears
            // from both the active section and the "available on cloud" section immediately,
            // before the (slow) cloud deletion completes.
            workspacesTree.markPendingDelete(ws);
            workspacesTree.invalidateRemoteCache();
            await engine.detachWorkspaceLocal(ws);
            workspacesTree.refresh();

            try {
              await engine.deleteCloudFilesOnly(ws);
            } catch (cloudErr) {
              // Cloud deletion failed — restore local config and bring workspace back to tree.
              workspacesTree.clearPendingDelete(ws);
              if (savedEntry) {
                await engine.restoreWorkspaceLocal(savedEntry, savedFiles);
              }
              workspacesTree.refresh();
              await vscode.window.showErrorMessage(
                `VSCodeSync: не удалось удалить workspace ${ws} с облака. Workspace восстановлен локально. Ошибка: ${String(cloudErr instanceof Error ? cloudErr.message : cloudErr)}`,
              );
              return;
            }

            // Success — clear pending flag and ensure cloud cache doesn't resurface the workspace.
            workspacesTree.clearPendingDelete(ws);
            workspacesTree.invalidateRemoteCache();

            let deletedCount = 0;
            for (const p of localPaths) {
              try {
                await fs.unlink(p);
                deletedCount++;
              } catch {
                // File may already be gone
              }
            }
            workspacesTree.refresh();
            await vscode.window.showInformationMessage(
              `VSCodeSync: workspace ${ws} удалён с облака. Удалено локально: ${String(deletedCount)} файлов.`,
            );
          } else {
            // "Удалить с облака, локальные оставить"
            const wc = await WorkspaceConfigManager.load(rt);
            const savedEntry = wc.activeWorkspaces.find((e) => e.workspaceId === ws);
            const savedFiles = wc.files.filter((f) => f.workspaceId === ws);

            // Optimistic hide: same pattern — disappear immediately, restore on error.
            workspacesTree.markPendingDelete(ws);
            workspacesTree.invalidateRemoteCache();
            await engine.detachWorkspaceLocal(ws);
            workspacesTree.refresh();

            try {
              await engine.deleteCloudFilesOnly(ws);
            } catch (cloudErr) {
              workspacesTree.clearPendingDelete(ws);
              if (savedEntry) {
                await engine.restoreWorkspaceLocal(savedEntry, savedFiles);
              }
              workspacesTree.refresh();
              await vscode.window.showErrorMessage(
                `VSCodeSync: не удалось удалить workspace ${ws} с облака. Workspace восстановлен локально. Ошибка: ${String(cloudErr instanceof Error ? cloudErr.message : cloudErr)}`,
              );
              return;
            }

            // Success — clear pending flag and drop stale cloud cache.
            workspacesTree.clearPendingDelete(ws);
            workspacesTree.invalidateRemoteCache();
            workspacesTree.refresh();
            await vscode.window.showInformationMessage(
              `VSCodeSync: workspace ${ws} удалён с облака. Локальные файлы не тронуты.`,
            );
          }
        },
        rt,
      );
      await statusBar.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }),

    vscode.commands.registerCommand("vscodesync.purgeEncryptedWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const wsId = await pickWorkspaceId(root);
      if (!wsId) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const ws = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
      const label = ws?.workspaceNote ?? wsId;
      const confirm = await vscode.window.showWarningMessage(
        `Удалить зашифрованные облачные данные workspace «${label}» (${wsId})? Все файлы в VSCodeSyncFiles/${wsId}/ будут уничтожены. Локальные копии останутся. Операция необратима.`,
        { modal: true },
        "Удалить",
      );
      if (confirm !== "Удалить") {
        return;
      }
      await runWithEngine(
        async (engine) => {
          await engine.deleteWorkspaceFromCloud(wsId);
          await vscode.window.showInformationMessage(
            `VSCodeSync: зашифрованные данные workspace ${wsId} удалены с облака. Локальный конфиг отключён.`,
          );
        },
        root,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
      fileDecorations.refresh();
    }),

    vscode.commands.registerCommand(
      "vscodesync.treeFilePush",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "file") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        const wc = await WorkspaceConfigManager.load(el.folderRoot.fsPath);
        const gconf = await globalConfig.load();
        const abs = trackedLocalAbsolutePath(el.folderRoot.fsPath, wc.pathMapping, gconf.machineName, el.localPath);
        if (!(await guardPathsBeforePush([abs]))) {
          return;
        }
        await runWithEngine(async (engine, root) => {
          const cfg = await WorkspaceConfigManager.load(root);
          const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
          if (!entry) {
            await vscode.window.showErrorMessage("Workspace не найден в конфиге.");
            return;
          }
          await engine.pushFile(cfg, el.workspaceId, el.localPath, entry);
          await vscode.window.showInformationMessage(`Push ${el.localPath}: готово.`);
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeFilePull",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "file") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        await runWithEngine(async (engine, root) => {
          const cfg = await WorkspaceConfigManager.load(root);
          const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
          if (!entry) {
            await vscode.window.showErrorMessage("Workspace не найден в конфиге.");
            return;
          }
          const result = await engine.pullFile(cfg, el.workspaceId, el.localPath, entry);
          if (result === "already_current") {
            await vscode.window.showInformationMessage(`${el.localPath}: уже актуален.`);
          } else {
            await vscode.window.showInformationMessage(`Pull ${el.localPath}: готово.`);
          }
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand("vscodesync.treeFileShowHistory", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const wc = await WorkspaceConfigManager.load(el.folderRoot.fsPath);
      const gconf = await globalConfig.load();
      const abs =
        el.resolvedFsPath ??
        trackedLocalAbsolutePath(el.folderRoot.fsPath, wc.pathMapping, gconf.machineName, el.localPath);
      await runShowFileHistory(runWithEngine, globalConfig, { root: el.folderRoot.fsPath, fsPath: abs });
    }),

    vscode.commands.registerCommand("vscodesync.treeFileOpenInCloud", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const wc = await WorkspaceConfigManager.load(el.folderRoot.fsPath);
      const gconf = await globalConfig.load();
      const abs =
        el.resolvedFsPath ??
        trackedLocalAbsolutePath(el.folderRoot.fsPath, wc.pathMapping, gconf.machineName, el.localPath);
      await openTrackedFileInCloudStorage(registry, globalConfig, { root: el.folderRoot.fsPath, fsPath: abs });
    }),

    vscode.commands.registerCommand("vscodesync.treeFileKeepMine", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const rootPath = el.folderRoot.fsPath;
      const cfg = await WorkspaceConfigManager.load(rootPath);
      const gconf = await globalConfig.load();
      const wnote =
        cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId)?.workspaceNote ?? el.workspaceId;
      for (const f of cfg.files) {
        if (f.workspaceId === el.workspaceId && f.localPath === el.localPath) {
          f.syncStatus = "ok";
        }
      }
      await WorkspaceConfigManager.save(cfg, rootPath);
      logSyncActivityRef?.({
        kind: "resolve_keep_mine",
        workspaceId: el.workspaceId,
        workspaceNote: wnote,
        relPath: el.localPath,
        machineName: gconf.machineName,
        provider: gconf.activeProvider ?? "onedrive",
      });
      await vscode.window.showInformationMessage("Конфликт снят (локально); при необходимости выполните Push.");
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }),

    vscode.commands.registerCommand("vscodesync.treeFileTakeTheirs", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const rootPath = el.folderRoot.fsPath;
      await runWithEngine(async (engine, root) => {
        let cfg = await WorkspaceConfigManager.load(root);
        const row = cfg.files.find((f) => f.workspaceId === el.workspaceId && f.localPath === el.localPath);
        if (row?.syncStatus !== "conflict") {
          await vscode.window.showWarningMessage("VSCodeSync: нет конфликта для этого файла.");
          return;
        }
        row.syncStatus = "ok";
        await WorkspaceConfigManager.save(cfg, root);
        cfg = await WorkspaceConfigManager.load(root);
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден.");
          return;
        }
        await engine.pullFile(cfg, el.workspaceId, el.localPath, entry);
        const gconf = await globalConfig.load();
        const wnote =
          cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId)?.workspaceNote ?? el.workspaceId;
        logSyncActivityRef?.({
          kind: "resolve_take_theirs",
          workspaceId: el.workspaceId,
          workspaceNote: wnote,
          relPath: el.localPath,
          machineName: gconf.machineName,
          provider: gconf.activeProvider ?? "onedrive",
        });
        await vscode.window.showInformationMessage(`Принята облачная версия: ${el.localPath}`);
      }, rootPath);
    }),
  );

  // Force sync: push local version despite a soft lock from another machine
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.treeFileForceSync", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const who = el.editingByName ?? el.editingBy ?? "другой машины";
      const picked = await vscode.window.showWarningMessage(
        `Файл «${path.basename(el.localPath)}» редактируется на «${who}». Принудительно отправить свою версию в облако?`,
        { modal: true },
        "Force Sync",
      );
      if (picked !== "Force Sync") {
        return;
      }
      const rootPath = el.folderRoot.fsPath;
      await runWithEngine(async (engine, root) => {
        let cfg = await WorkspaceConfigManager.load(root);
        const row = cfg.files.find((f) => f.workspaceId === el.workspaceId && f.localPath === el.localPath);
        if (!row) {
          await vscode.window.showErrorMessage("VSCodeSync: файл не найден в конфигурации.");
          return;
        }
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден.");
          return;
        }
        // Clear soft lock locally so push guard passes, then push
        delete row.editingBy;
        delete row.editingByName;
        row.syncStatus = "ok";
        await WorkspaceConfigManager.save(cfg, root);
        cfg = await WorkspaceConfigManager.load(root);
        await engine.pushFile(cfg, el.workspaceId, el.localPath, entry);
        await WorkspaceConfigManager.save(cfg, root);
        const gconf = await globalConfig.load();
        const wnote = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId)?.workspaceNote ?? el.workspaceId;
        logSyncActivityRef?.({
          kind: "resolve_keep_mine",
          workspaceId: el.workspaceId,
          workspaceNote: wnote,
          relPath: el.localPath,
          machineName: gconf.machineName,
          provider: gconf.activeProvider ?? "onedrive",
        });
        await vscode.window.showInformationMessage(`Force Sync выполнен: ${el.localPath}`);
      }, rootPath);
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }),
  );

    // Palette conflict resolution commands (work from active editor or pick from list)
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.keepMine", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg = await WorkspaceConfigManager.load(target.root);
      const fileEntry = cfg.files.find((f) => f.localPath === rel && f.syncStatus === "conflict");
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не находится в состоянии конфликта.");
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.resolveConflictKeepMine(fileEntry.workspaceId, rel);
        await vscode.window.showInformationMessage(`Конфликт разрешён: оставлена локальная версия «${path.basename(target.fsPath)}».`);
        notifiedConflictKeys.delete(`${fileEntry.workspaceId}:${rel}`);
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.takeTheirs", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg = await WorkspaceConfigManager.load(target.root);
      const fileEntry = cfg.files.find((f) => f.localPath === rel && f.syncStatus === "conflict");
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не находится в состоянии конфликта.");
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.resolveConflictTakeTheirs(fileEntry.workspaceId, rel);
        await vscode.window.showInformationMessage(`Конфликт разрешён: принята облачная версия «${path.basename(target.fsPath)}».`);
        notifiedConflictKeys.delete(`${fileEntry.workspaceId}:${rel}`);
      }, target.root);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.showStatus", async () => {
      const cfg = await globalConfig.load();
      const p = await registry.getActive();
      const name = (p?.type ?? cfg.activeProvider ?? "none") as string;
      await vscode.window.showInformationMessage(
        `VSCodeSync · ${cfg.machineName} · провайдер: ${name}`,
      );
    }),

    vscode.commands.registerCommand("vscodesync.createWorkspace", async () => {
      const note =
        (await vscode.window.showInputBox({
          title: "VSCodeSync: новый workspace",
          placeHolder: "Описание / название проекта",
        })) ?? "";
      if (!note) {
        return;
      }
      await runWithEngine(async (engine, _root, gc) => {
        const cfg = await gc.load();
        const t = cfg.activeProvider ?? "onedrive";
        // Warn if a workspace with the same note already exists in the cloud
        try {
          const existing = await engine.listRemoteWorkspaceSummaries();
          const duplicate = existing.find(
            (w) => w.workspaceNote.trim().toLowerCase() === note.trim().toLowerCase(),
          );
          if (duplicate) {
            const proceed = await vscode.window.showWarningMessage(
              `VSCodeSync: workspace с названием «${duplicate.workspaceNote}» уже существует в облаке (${duplicate.workspaceId}). Создать ещё один?`,
              { modal: true },
              "Создать",
            );
            if (proceed !== "Создать") {
              return;
            }
          }
        } catch {
          // Non-fatal: listing may fail if cloud is unreachable
        }
        const wid = await engine.createWorkspace(note, t);

        // Quick-pick of initial file templates
        type TemplateItem = vscode.QuickPickItem & { globs: string[] };
        const templateItems: TemplateItem[] = [
          { label: "$(dash) Без файлов", description: "Пустой workspace, добавить файлы позже", globs: [] },
          { label: "$(key) .env файлы", description: "**/.env, **/.env.*, **/dotenv*", globs: ["**/.env", "**/.env.*", "**/dotenv*"] },
          { label: "$(gear) config/", description: "config/**, *.config.*, *.json (верхний уровень)", globs: ["config/**", "*.config.*", "*.json"] },
          { label: "$(terminal) scripts/ / bin/", description: "scripts/**, bin/**", globs: ["scripts/**", "bin/**"] },
          { label: "$(code) src/ / lib/", description: "src/**, lib/**", globs: ["src/**", "lib/**"] },
          { label: "$(list-ordered) Весь проект", description: "** — все файлы (осторожно: может быть много)", globs: ["**"] },
        ];
        const templatePick = await vscode.window.showQuickPick<TemplateItem>(templateItems, {
          placeHolder: "Начальный набор файлов (опционально)",
          title: `Шаблон для «${note}»`,
        });

        if (templatePick && templatePick.globs.length > 0) {
          const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**}";
          const uris: vscode.Uri[] = [];
          for (const glob of templatePick.globs) {
            const found = await vscode.workspace.findFiles(glob, exclude, 500);
            for (const u of found) {
              if (!uris.some((x) => x.fsPath === u.fsPath)) {
                uris.push(u);
              }
            }
          }
          if (uris.length === 0) {
            await vscode.window.showInformationMessage(`VSCodeSync: файлы по шаблону не найдены. Workspace создан: ${wid}.`);
          } else {
            const cfg2 = vscode.workspace.getConfiguration(CFG_SECTION);
            const warnThreshold = cfg2.get<number>("batchAddWarnThreshold", 50);
            if (uris.length > warnThreshold) {
              const ok = await vscode.window.showWarningMessage(
                `VSCodeSync: найдено ${String(uris.length)} файлов. Добавить все в workspace «${note}»?`,
                { modal: true },
                "Добавить",
              );
              if (ok !== "Добавить") {
                await vscode.window.showInformationMessage(`Workspace создан: ${wid} (без файлов).`);
                return;
              }
            }
            await engine.addFiles(wid, uris.map((u) => u.fsPath));
            await vscode.window.showInformationMessage(
              `Workspace «${note}» создан и добавлено ${String(uris.length)} файлов.`,
            );
          }
        } else {
          await vscode.window.showInformationMessage(`Workspace создан: ${wid}`);
        }
      });
    }),

    vscode.commands.registerCommand("vscodesync.connectCloudWorkspace", async () => {
      await runWithEngine(async (engine, root, gc) => {
        const list = await engine.listRemoteWorkspaceSummaries();
        if (list.length === 0) {
          await vscode.window.showInformationMessage(
            "VSCodeSync: в облаке не найдено ни одного workspace (папка VSCodeSyncFiles пуста или нет доступа).",
          );
          return;
        }
        const cfg = await gc.load();
        const activeProvider = cfg.activeProvider ?? "onedrive";
        const wc = await WorkspaceConfigManager.load(root);
        const alreadyAttached = new Set(wc.activeWorkspaces.map((w) => w.workspaceId));

        type WsPick = vscode.QuickPickItem & { workspaceId: string; providerType?: string };
        const items: WsPick[] = list
          .filter((w) => !alreadyAttached.has(w.workspaceId))
          .map((w) => ({
            label: w.workspaceNote || w.workspaceId,
            description: w.workspaceId,
            workspaceId: w.workspaceId,
          }));

        if (items.length === 0) {
          await vscode.window.showInformationMessage(
            "VSCodeSync: все доступные workspace уже подключены в этом проекте.",
          );
          return;
        }

        const picks = await vscode.window.showQuickPick<WsPick>(items, {
          placeHolder: "Выберите workspace на облаке (можно несколько)",
          canPickMany: true,
        });
        if (!picks || picks.length === 0) {
          return;
        }

        // Dry-run preview before connecting
        const previewChannel = vscode.window.createOutputChannel("VSCodeSync: Dry-run Connect");
        const previewPlan = await engine.previewSyncPlan();
        if (previewPlan.length > 0) {
          writeSyncPreviewOutput(previewChannel, previewPlan);
          const doConnect = await vscode.window.showInformationMessage(
            `VSCodeSync: подключение ${String(picks.length)} workspace(ов). Текущий план sync показан в Output → «VSCodeSync: Dry-run Connect». Продолжить?`,
            { modal: true },
            "Подключить",
          );
          if (doConnect !== "Подключить") {
            previewChannel.dispose();
            return;
          }
        }
        previewChannel.dispose();

        // Check for file path overlaps with already tracked files
        const locallyTracked = new Set(wc.files.map((f) => f.localPath));
        for (const pick of picks) {
          try {
            const cloudFiles = await engine.listCloudWorkspaceFiles(pick.workspaceId);
            const overlaps = cloudFiles.filter((p) => locallyTracked.has(p));
            if (overlaps.length > 0) {
              const sample = overlaps.slice(0, 5).join("\n  ");
              const more = overlaps.length > 5 ? `\n  …и ещё ${String(overlaps.length - 5)}` : "";
              const proceed = await vscode.window.showWarningMessage(
                `VSCodeSync: workspace «${pick.label}» содержит файлы, уже отслеживаемые другим workspace:\n\n  ${sample}${more}\n\nПодключение добавит их в оба workspace. Продолжить?`,
                { modal: true },
                "Подключить",
              );
              if (proceed !== "Подключить") {
                continue;
              }
            }
          } catch {
            /* non-fatal: overlap check failed (network), proceed anyway */
          }
          try {
            await engine.attachCloudWorkspace(pick.workspaceId);
            connected++;
            void (async () => {
              const { maybePromptPathMapperAfterAttach } = await import("./ui/aiPathMapperCommand.js");
              await maybePromptPathMapperAfterAttach(context, pick.workspaceId);
            })();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await vscode.window.showErrorMessage(
              `VSCodeSync: не удалось подключить «${pick.label}» (${pick.workspaceId}) — ${msg}`,
            );
          }
        }

        // Warn about providerType mismatch after attaching
        const wcAfter = await WorkspaceConfigManager.load(root);
        const mismatch = wcAfter.activeWorkspaces.filter(
          (w) => w.providerType != null && w.providerType !== activeProvider,
        );
        if (mismatch.length > 0) {
          const names = mismatch.map((w) => `«${w.workspaceNote || w.workspaceId}»`).join(", ");
          await vscode.window.showWarningMessage(
            `VSCodeSync: ${names} — провайдер в манифесте (${mismatch[0]?.providerType ?? "?"}) отличается от активного (${activeProvider}). Файлы синхронизируются, но рекомендуется миграция (VSCodeSync: Migrate Provider).`,
          );
        }

        if (connected > 0) {
          await vscode.window.showInformationMessage(
            `VSCodeSync: подключено ${String(connected)} workspace(ов).`,
          );
        }
      });
    }),

    // VS Code passes (uri, allUris) when multiple files are selected in Explorer
    vscode.commands.registerCommand("vscodesync.addCurrentFile", async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
      // Multi-select: use all selected URIs if provided; otherwise fall back to single
      const selectedUris =
        Array.isArray(allUris) && allUris.length > 1
          ? allUris
          : uri
          ? [uri]
          : undefined;

      const target = await resolveFileTarget(selectedUris?.[0] ?? uri);
      if (!target) {
        return;
      }

      const underRoot = (p: string): boolean => {
        const rel = path.relative(target.root, p);
        return rel !== ".." && !rel.startsWith(`..${path.sep}`);
      };

      const rawPaths: string[] = selectedUris
        ? selectedUris.map((u) => u.fsPath).filter((p) => underRoot(p))
        : [target.fsPath];

      const ws = await pickWorkspaceId(target.root);
      if (!ws) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(target.root);
      const ent = wc.activeWorkspaces.find((w) => w.workspaceId === ws);
      const gconf = await globalConfig.load();

      let selectionHadDirectory = false;
      for (const p of rawPaths) {
        try {
          const st = await fs.stat(p);
          if (st.isDirectory()) {
            selectionHadDirectory = true;
          }
        } catch {
          /* ignore missing */
        }
      }

      const expanded = await collectFilesToAddUnderRoots(target.root, rawPaths, {
        entry: ent,
        cfg: wc,
        machineName: gconf.machineName,
      });
      if (expanded.length === 0) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: нет файлов для добавления (пустая папка или все пути совпали с правилами исключения).",
        );
        return;
      }
      if (expanded.length > 500) {
        const big = await vscode.window.showWarningMessage(
          `VSCodeSync: будет добавлено ${String(expanded.length)} файлов. Продолжить?`,
          { modal: true },
          "Продолжить",
        );
        if (big !== "Продолжить") {
          return;
        }
      }
      const useBulkAddConfirm = expanded.length > 1 || selectionHadDirectory;
      if (useBulkAddConfirm) {
        const ok = await vscode.window.showInformationMessage(
          `Добавить в VSCodeSync ${String(expanded.length)} файл(ов) и синхронизировать?`,
          { modal: true },
          "Добавить",
        );
        if (ok !== "Добавить") {
          return;
        }
      }
      const withPreview = !useBulkAddConfirm;
      if (
        !(await guardPathsBeforeAdd(expanded, withPreview, target.root, {
          entry: ent,
          cfg: wc,
          machineName: gconf.machineName,
        }))
      ) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.addFiles(ws, expanded);
        if (expanded.length === 1) {
          await vscode.window.showInformationMessage("Файл добавлен и синхронизирован.");
        } else {
          await vscode.window.showInformationMessage(
            `${String(expanded.length)} файлов добавлено и синхронизировано.`,
          );
        }
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.addFolderToSync", async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
      await vscode.commands.executeCommand("vscodesync.addCurrentFile", uri, allUris);
    }),

    vscode.commands.registerCommand("vscodesync.addToNewWorkspace", runAddToNewWorkspace),

    vscode.commands.registerCommand("vscodesync.removeFromSync", async (arg?: unknown) => {
      const target = await resolveFileTargetLoose(globalConfig, arg);
      if (!target) {
        return;
      }
      const cfg = await WorkspaceConfigManager.load(target.root);
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const fileEntry = cfg.files.find((f) => f.localPath === rel);
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
        return;
      }
      const basename = path.basename(target.fsPath);
      type RemoveChoice = "cloud" | "local" | "all";
      const choice = await vscode.window.showWarningMessage(
        `Как убрать «${basename}» из VSCodeSync?`,
        { modal: true },
        "Удалить с облака",
        "Только отвязать здесь",
        "Убрать у всех машин",
      );
      if (!choice) {
        return;
      }
      const action: RemoveChoice =
        choice === "Удалить с облака"
          ? "cloud"
          : choice === "Только отвязать здесь"
            ? "local"
            : "all";
      await runWithEngine(async (engine) => {
        if (action === "cloud") {
          await engine.removeTrackedFiles(fileEntry.workspaceId, [target.fsPath]);
          await vscode.window.showInformationMessage("Файл убран из синхронизации и удалён с облака.");
        } else if (action === "local") {
          await engine.untrackFileLocal(fileEntry.workspaceId, [target.fsPath]);
          await vscode.window.showInformationMessage(
            "Файл отвязан на этой машине. В облаке и на других машинах остался.",
          );
        } else {
          await engine.untrackFileTombstoneOnly(fileEntry.workspaceId, [target.fsPath]);
          await vscode.window.showInformationMessage(
            "Файл убран у всех машин (tombstone). Blob в облаке не удалён.",
          );
        }
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.pushCurrentFile", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const abs = path.join(target.root, ...rel.split("/"));
      if (!(await guardPathsBeforePush([abs]))) {
        return;
      }
      await runWithEngine(async (engine, root) => {
        const cfg = await WorkspaceConfigManager.load(root);
        const fileEntry = cfg.files.find((f) => f.localPath === rel);
        if (!fileEntry) {
          await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
          return;
        }
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === fileEntry.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден в конфиге.");
          return;
        }
        await engine.pushFile(cfg, fileEntry.workspaceId, rel, entry);
        await vscode.window.showInformationMessage(`Push ${rel}: готово.`);
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.pullCurrentFile", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      await runWithEngine(async (engine, root) => {
        const cfg = await WorkspaceConfigManager.load(root);
        const fileEntry = cfg.files.find((f) => f.localPath === rel);
        if (!fileEntry) {
          await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
          return;
        }
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === fileEntry.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден в конфиге.");
          return;
        }
        const result = await engine.pullFile(cfg, fileEntry.workspaceId, rel, entry);
        if (result === "already_current") {
          await vscode.window.showInformationMessage(`${rel}: уже актуален.`);
        } else {
          await vscode.window.showInformationMessage(`Pull ${rel}: готово.`);
        }
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.takeSyncOwnership", async () => {
      const storageDir = globalConfig.getStorageDir();
      const currentRoots = roots().map((f) => f.uri.fsPath);
      if (currentRoots.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет открытых папок workspace.");
        return;
      }
      const holder = await peekWorkspaceInstanceLockHolder(storageDir, currentRoots).catch(() => null);
      const pidHint = holder ? ` Текущий держатель — PID ${String(holder.pid)}.` : "";
      const choice = await vscode.window.showWarningMessage(
        `VSCodeSync: стать основным окном синхронизации?${pidHint} Push из этого окна будет разрешён. Другое окно VSCode с тем же workspace перейдёт в Read-only.`,
        { modal: true },
        "Стать основным",
      );
      if (choice !== "Стать основным") {
        return;
      }
      await forceAcquireWorkspaceInstanceLock(storageDir, currentRoots);
      refreshWorkspaceInstanceLock();
      await vscode.window.showInformationMessage("VSCodeSync: это окно теперь основное. Push доступен.");
    }),

    vscode.commands.registerCommand("vscodesync.moveCurrentFileToWorkspace", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg0 = await WorkspaceConfigManager.load(target.root);
      const fileEntry = cfg0.files.find((f) => f.localPath === rel);
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
        return;
      }
      const toWs = await pickOtherWorkspaceId(target.root, fileEntry.workspaceId);
      if (!toWs) {
        return;
      }
      const fromWs = fileEntry.workspaceId;
      const gconf = await globalConfig.load();
      const ent = cfg0.activeWorkspaces.find((w) => w.workspaceId === toWs);
      if (
        !(await guardPathsBeforeAdd([target.fsPath], false, target.root, {
          entry: ent,
          cfg: cfg0,
          machineName: gconf.machineName,
        }))
      ) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.removeTrackedFiles(fromWs, [target.fsPath]);
        await engine.addFiles(toWs, [target.fsPath]);
        await vscode.window.showInformationMessage("Файл перемещён в другой workspace.");
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.diffWithCloud", async (arg?: unknown) => {
      const target = await resolveFileTargetLoose(globalConfig, arg);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg0 = await WorkspaceConfigManager.load(target.root);
      if (!cfg0.files.some((f) => f.localPath === rel)) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
        return;
      }
      await runWithEngine(
        async (engine) => {
          const { body } = await engine.downloadTrackedBlob(rel);
          const tmp = path.join(
            os.tmpdir(),
            `vscodesync-cloud-${String(Date.now())}-${path.basename(target.fsPath)}`,
          );
          await fs.writeFile(tmp, body);
          const right = vscode.Uri.file(tmp);
          const left = vscode.Uri.file(target.fsPath);
          const title = `${path.basename(target.fsPath)} (локально ↔ облако)`;
          await vscode.commands.executeCommand("vscode.diff", left, right, title);
        },
        target.root,
      );
    }),

    vscode.commands.registerCommand("vscodesync.openConflictDiff3way", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      await runConflict3WayDiff(runWithEngine, target);
    }),

    vscode.commands.registerCommand("vscodesync.showFileHistory", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      await runShowFileHistory(runWithEngine, globalConfig, target);
    }),

    vscode.commands.registerCommand("vscodesync.openInCloudStorage", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      await openTrackedFileInCloudStorage(registry, globalConfig, target);
    }),

    vscode.commands.registerCommand("vscodesync.resolveTakeTheirs", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      await runWithEngine(async (engine, root) => {
        let cfg = await WorkspaceConfigManager.load(root);
        const row = cfg.files.find((f) => f.localPath === rel);
        if (row?.syncStatus !== "conflict") {
          await vscode.window.showWarningMessage("VSCodeSync: нет конфликта для этого файла.");
          return;
        }
        row.syncStatus = "ok";
        await WorkspaceConfigManager.save(cfg, root);
        cfg = await WorkspaceConfigManager.load(root);
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === row.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден.");
          return;
        }
        await engine.pullFile(cfg, row.workspaceId, rel, entry);
        const gconf = await globalConfig.load();
        const wnote =
          cfg.activeWorkspaces.find((w) => w.workspaceId === row.workspaceId)?.workspaceNote ?? row.workspaceId;
        logSyncActivityRef?.({
          kind: "resolve_take_theirs",
          workspaceId: row.workspaceId,
          workspaceNote: wnote,
          relPath: rel,
          machineName: gconf.machineName,
          provider: gconf.activeProvider ?? "onedrive",
        });
        await vscode.window.showInformationMessage(`Принята облачная версия: ${rel}`);
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.pushAll", async () => {
      await runWithEngine(async (engine) => {
        await engine.pushAll();
        await vscode.window.showInformationMessage("Push all: готово.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.pullAll", async () => {
      await runWithEngine(async (engine) => {
        await engine.pullAll();
        await vscode.window.showInformationMessage("Pull all: готово.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.syncWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.syncWorkspace(ws);
        await vscode.window.showInformationMessage(`Sync ${ws}: готово.`);
      });
    }),

    vscode.commands.registerCommand("vscodesync.pushWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.pushAll(ws);
        await vscode.window.showInformationMessage("Push workspace: готово.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.pullWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.pullAll(ws);
        await vscode.window.showInformationMessage("Pull workspace: готово.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.detachWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("Нет активных workspace.");
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      const aw = wc.activeWorkspaces.find((w) => w.workspaceId === ws);
      const confirm = await vscode.window.showWarningMessage(
        `Отключить «${aw?.workspaceNote ?? ws}» только в этом проекте? Данные в облаке не удаляются.`,
        { modal: true },
        "Отключить",
      );
      if (confirm !== "Отключить") {
        return;
      }
      await runWithEngine(
        async (engine) => {
          await engine.detachWorkspaceLocal(ws);
          await vscode.window.showInformationMessage("Workspace отключён локально.");
        },
        undefined,
      );
    }),

    vscode.commands.registerCommand("vscodesync.renameWorkspaceNote", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const aw = wc.activeWorkspaces.find((w) => w.workspaceId === ws);
      const note =
        (await vscode.window.showInputBox({
          title: "VSCodeSync: имя workspace",
          value: aw?.workspaceNote ?? ws,
          validateInput: (v) => (v.trim() ? undefined : "Укажите непустое имя"),
        })) ?? "";
      if (!note.trim()) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.renameWorkspaceNote(ws, note.trim());
        await vscode.window.showInformationMessage("Название обновлено в облаке и локально.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.setGitBranchWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(async (engine) => {
        const fields = await engine.getWorkspaceManifestFields(ws);
        const current = fields === undefined ? "" : (fields.gitBranch ?? "");
        const branches = await listGitBranches(root);
        type BranchPick = vscode.QuickPickItem & { mode: "clear" | "branch" | "manual" };
        const items: BranchPick[] = [
          { label: "— Очистить привязку —", description: "Workspace всегда активен", mode: "clear" },
          ...branches.map((b) => ({ label: b, mode: "branch" as const })),
          { label: "Другая ветка…", description: "Ввод вручную", mode: "manual" },
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Текущая привязка: ${current || "нет"}`,
          title: "VSCodeSync: git branch для workspace",
        });
        if (!picked) {
          return;
        }
        let branch = "";
        if (picked.mode === "clear") {
          branch = "";
        } else if (picked.mode === "manual") {
          const manual =
            (await vscode.window.showInputBox({
              title: "VSCodeSync: имя ветки",
              prompt: "Как в git (например main или feature/auth)",
              value: current,
            })) ?? undefined;
          if (manual === undefined) {
            return;
          }
          branch = manual.trim();
        } else {
          branch = picked.label.trim();
        }
        await engine.setWorkspaceGitBranch(ws, branch);
        void applyBranchPolicyForRoot(root, gitBranchActivationDeps);
        await vscode.window.showInformationMessage(
          branch === ""
            ? "VSCodeSync: привязка git branch снята; workspace всегда активен."
            : "VSCodeSync: gitBranch записан в облачный манифест и кэш локально.",
        );
      });
    }),

    vscode.commands.registerCommand("vscodesync.editWorkspaceTags", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(async (engine) => {
        const fields = await engine.getWorkspaceManifestFields(ws);
        const currentTags =
          fields === undefined ? "" : fields.tags.length > 0 ? fields.tags.join(", ") : "";
        const raw = await vscode.window.showInputBox({
          title: "VSCodeSync: теги workspace",
          prompt: "Через запятую; пробелы обрезаются. Пусто — очистить теги",
          value: currentTags,
        });
        if (raw === undefined) {
          return;
        }
        const tags = raw.split(",").map((s) => s.trim());
        await engine.setWorkspaceTags(ws, tags);
        await vscode.window.showInformationMessage("Теги в облачном манифесте обновлены.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.healthCheck", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync Health: откройте папку workspace.");
        return;
      }
      const provider = await tryAuthenticatedProvider(registry);
      const gcData = await globalConfig.load();
      const encKey = await getEncKey();
      const report = await buildHealthCheckReport({
        workspaceFolders: folders,
        globalConfig,
        activeProviderType: gcData.activeProvider,
        provider,
        machineId: gcData.machineId,
        machineName: gcData.machineName,
        createEngine: (root, p) => makeEngine(root, p, gcData.machineId, gcData.machineName, encKey),
        offlineQueue: offlineQueueStore,
        scheduleDeferred: scheduleDeferredStore,
      });
      healthCheckChannel.clear();
      for (const ln of report.lines) {
        healthCheckChannel.appendLine(ln);
      }
      healthCheckChannel.show(true);

      const actions: string[] = [];
      if (report.machinesRegistryStale && provider) {
        actions.push("Обновить _machines.json");
      }
      if (report.staleLockTargets.length > 0 && provider) {
        actions.push("Починить stale lock");
      }
      actions.push("Закрыть");

      const picked = await vscode.window.showInformationMessage(
        "VSCodeSync Health Check — открыта панель Output. Изменения в облаке только по кнопкам ниже.",
        ...actions,
      );

      if (picked === "Обновить _machines.json" && provider) {
        try {
          await syncMachinesRegistrySelf(provider, gcData.machineId, gcData.machineName);
          await vscode.window.showInformationMessage("VSCodeSync: _machines.json обновлён (запись этой машины).");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await vscode.window.showErrorMessage(`VSCodeSync: не удалось обновить реестр — ${msg}`);
        }
      }

      if (picked === "Починить stale lock" && provider) {
        let total = 0;
        for (const t of report.staleLockTargets) {
          try {
            const eng = makeEngine(t.folderRoot, provider, gcData.machineId, gcData.machineName, encKey);
            total += await eng.clearStaleManifestEditingLocks(t.workspaceId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await vscode.window.showErrorMessage(`VSCodeSync: починка stale lock — ${t.workspaceNote}: ${msg}`);
            total = -1;
            break;
          }
        }
        if (total > 0) {
          await vscode.window.showInformationMessage(
            `VSCodeSync: сброшено устаревших soft lock в манифесте: ${String(total)}`,
          );
        }
        if (total === 0 && report.staleLockTargets.length > 0) {
          await vscode.window.showInformationMessage(
            "VSCodeSync: устаревших soft lock не осталось (уже сброшены или порог времени изменился). Перезапустите Health Check.",
          );
        }
      }
    }),

    vscode.commands.registerCommand("vscodesync.repairState", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace для repair.");
        return;
      }

      // Let the user choose repair mode
      const mode = await vscode.window.showQuickPick(
        [
          {
            label: "$(sync) Обычный ремонт",
            description: "Обновить ETag, имя, провайдер из манифеста (быстро)",
            value: "normal" as const,
          },
          {
            label: "$(search) Полный ремонт (сканирование облака)",
            description: "Восстановить _meta.json из структуры папок на облаке — для повреждённых/пустых манифестов",
            value: "scan" as const,
          },
        ],
        { placeHolder: "Режим ремонта" },
      );
      if (!mode) return;

      if (mode.value === "normal") {
        await runWithEngine(async (engine) => {
          await engine.repairLocalStateFromCloud();
          await vscode.window.showInformationMessage(
            "VSCodeSync Repair: ETag манифеста и _meta, имя workspace подтянуты с облака.",
          );
        });
        return;
      }

      // Scan mode: pick workspace to scan (manifest may be missing/corrupted)
      type WsPick = vscode.QuickPickItem & { workspaceId: string };
      const items: WsPick[] = wc.activeWorkspaces.map((w) => ({
        label: w.workspaceNote || w.workspaceId,
        description: w.workspaceId,
        workspaceId: w.workspaceId,
      }));
      const pick = await vscode.window.showQuickPick<WsPick>(items, {
        placeHolder: "Выберите workspace для сканирования облака",
      });
      if (!pick) return;

      await runWithEngine(async (engine) => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `VSCodeSync: сканирование облака для «${pick.label}»…`,
            cancellable: false,
          },
          async () => {
            const found = await engine.repairByCloudScan(pick.workspaceId);
            if (found.length === 0) {
              await vscode.window.showInformationMessage(
                `VSCodeSync Repair Scan: в облаке нет файлов для workspace «${pick.label}».`,
              );
              return;
            }
            const doPull = await vscode.window.showInformationMessage(
              `VSCodeSync Repair Scan: найдено ${String(found.length)} файлов в облаке. _meta.json восстановлен. Выполнить Pull для загрузки файлов?`,
              "Pull сейчас",
              "Позже",
            );
            if (doPull === "Pull сейчас") {
              await engine.pullAll(pick.workspaceId);
              await vscode.window.showInformationMessage("VSCodeSync Repair: Pull завершён.");
            }
          },
        );
      });
    }),

    vscode.commands.registerCommand("vscodesync.openSyncSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:vscodesync.vscodesync");
    }),

    vscode.commands.registerCommand("vscodesync.toggleTelemetry", async () => {
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const cur = cfg.get<boolean>("telemetry", false);
      await cfg.update("telemetry", !cur, vscode.ConfigurationTarget.Global);
      const vscodeOff = !vscode.env.isTelemetryEnabled;
      if (cur) {
        await vscode.window.showInformationMessage(
          "VSCodeSync: расширение больше не отправляет события (vscodesync.telemetry): выкл.",
        );
      } else {
        await vscode.window.showInformationMessage(
          vscodeOff
            ? "VSCodeSync: телеметрия расширения включена. Чтобы события уходили в Microsoft / инструменты разработчика, включите телеметрию в настройках VS Code. Внешняя отправка — только при непустом vscodesync.telemetryIngestUrl."
            : "VSCodeSync: телеметрия расширения включена. События без путей к файлам; внешний endpoint — только при заданном vscodesync.telemetryIngestUrl.",
        );
      }
    }),

    vscode.commands.registerCommand("vscodesync.showSyncSummary", async () => {
      await statusBar.showDashboard();
    }),

    vscode.commands.registerCommand("vscodesync.previewSync", async () => {
      const root = pickRoot();
      if (!root) {
        await vscode.window.showErrorMessage("VSCodeSync: откройте папку.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }
      let scope: string | undefined;
      if (wc.activeWorkspaces.length === 1) {
        scope = wc.activeWorkspaces[0]?.workspaceId;
      } else {
        type WsPick = vscode.QuickPickItem & { wsId?: string };
        const picked = await vscode.window.showQuickPick<WsPick>(
          [
            {
              label: "$(sync) Все активные workspace",
              description: "Сводка по каждому",
              wsId: undefined,
            },
            ...wc.activeWorkspaces.map((w) => ({
              label: w.workspaceNote,
              description: w.workspaceId,
              wsId: w.workspaceId,
            })),
          ],
          { placeHolder: "Preview Sync — для какого workspace" },
        );
        if (!picked) {
          return;
        }
        scope = picked.wsId;
      }
      await runWithEngine(
        async (engine) => {
          const plan = await engine.previewSyncPlan(scope);
          writeSyncPreviewOutput(syncPreviewChannel, plan);
          syncPreviewChannel.show(true);
          const nPush = plan.reduce((acc, w) => acc + w.files.filter((f) => f.action === "push").length, 0);
          const nPull = plan.reduce((acc, w) => acc + w.files.filter((f) => f.action === "pull").length, 0);
          const nConf = plan.reduce(
            (acc, w) => acc + w.files.filter((f) => f.action === "conflict" || f.action === "conflict_pending").length,
            0,
          );
          await vscode.window.showInformationMessage(
            `Preview Sync: push ${String(nPush)} · pull ${String(nPull)} · конфликты ${String(nConf)}. Подробности — панель Output «VSCodeSync · Preview».`,
          );
        },
        undefined,
      );
    }),

    vscode.commands.registerCommand("vscodesync.resolveConflicts", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const conflicts = wc.files.filter((f) => f.syncStatus === "conflict");
      if (conflicts.length === 0) {
        await vscode.window.showInformationMessage("VSCodeSync: нет конфликтов.");
        return;
      }

      type BatchChoice = "keepMineAll" | "taketheirsAll" | "manual";

      // Bulk choice first if > 1 conflict
      let batchMode: BatchChoice = "manual";
      if (conflicts.length > 1) {
        const bulk = await vscode.window.showWarningMessage(
          `VSCodeSync: ${String(conflicts.length)} файлов в конфликте. Как разрешить?`,
          "Keep Mine All",
          "Take Theirs All",
          "Разрешить по одному",
        );
        if (!bulk) {
          return;
        }
        if (bulk === "Keep Mine All") {
          batchMode = "keepMineAll";
        } else if (bulk === "Take Theirs All") {
          batchMode = "taketheirsAll";
        }
      }

      if (batchMode !== "manual") {
        await runWithEngine(async (engine) => {
          for (const f of conflicts) {
            try {
              if (batchMode === "keepMineAll") {
                await engine.resolveConflictKeepMine(f.workspaceId, f.localPath);
              } else {
                await engine.resolveConflictTakeTheirs(f.workspaceId, f.localPath);
              }
              notifiedConflictKeys.delete(`${f.workspaceId}:${f.localPath}`);
            } catch {
              /* individual errors are non-fatal in batch */
            }
          }
          await vscode.window.showInformationMessage(
            `VSCodeSync: разрешено ${String(conflicts.length)} конфликтов (${batchMode === "keepMineAll" ? "Keep Mine" : "Take Theirs"}).`,
          );
        });
        return;
      }

      // One-by-one queue
      const aiAvailable = await isAiMergeAvailable();
      for (const f of conflicts) {
        let resolved = false;
        while (!resolved) {
          const idx = conflicts.indexOf(f);
          const wsNote = wc.activeWorkspaces.find((w) => w.workspaceId === f.workspaceId)?.workspaceNote ?? f.workspaceId;
          const buttons = aiAvailable
            ? ["Keep Mine", "Take Theirs", "Open Diff", "✨ Merge with AI", "Skip"]
            : ["Keep Mine", "Take Theirs", "Open Diff", "Skip"];
          const choice = await vscode.window.showWarningMessage(
            `⚠ Конфликт ${String(idx + 1)}/${String(conflicts.length)}: ${f.localPath} (workspace «${wsNote}»)`,
            ...buttons,
          );
          if (!choice || choice === "Skip") {
            resolved = true;
            continue;
          }
          if (choice === "Open Diff") {
            const conflictUri = vscode.Uri.file(path.join(root, ...f.localPath.split("/")));
            await runConflict3WayDiff(runWithEngine, { root, fsPath: conflictUri.fsPath });
            continue; // re-show the same file dialog
          }
          if (choice === "✨ Merge with AI") {
            const conflictUri = vscode.Uri.file(path.join(root, ...f.localPath.split("/")));
            const aiResolved = await runAiMergeForConflict(
              runWithEngine,
              { root, fsPath: conflictUri.fsPath },
              f.workspaceId,
              f.localPath,
              notifiedConflictKeys,
            );
            if (aiResolved) {
              resolved = true;
            }
            // If not resolved (error / model refused) — re-show dialog for manual choice
            continue;
          }
          await runWithEngine(async (engine) => {
            if (choice === "Keep Mine") {
              await engine.resolveConflictKeepMine(f.workspaceId, f.localPath);
            } else {
              await engine.resolveConflictTakeTheirs(f.workspaceId, f.localPath);
            }
            notifiedConflictKeys.delete(`${f.workspaceId}:${f.localPath}`);
          });
          resolved = true;
        }
      }
    }),

    vscode.commands.registerCommand("vscodesync.setActiveProvider", async () => {
      await runActiveProviderSwitch({
        registry,
        globalConfig,
        workspacesTree,
        signInOneDrive: () => runOneDriveAuth(true),
        signInGoogleDrive: () => runGoogleDriveAuth(true),
        signInDropbox: () => runDropboxAuth(true),
        signInYandexDisk: () => runYandexDiskAuth(true),
        refreshStatusAndPanels: async () => {
          await statusBar.refresh();
          workspacesTree.refresh();
          fileDecorations.refresh();
          void refreshActiveEditorSyncContext();
          refreshCloudWebhooks();
        },
      });
    }),

    vscode.commands.registerCommand("vscodesync.onedriveSignIn", async () => {
      await runOneDriveAuth(true);
    }),

    vscode.commands.registerCommand("vscodesync.onedriveSignInHeadless", async () => {
      await runOneDriveAuth(false);
    }),

    vscode.commands.registerCommand("vscodesync.googleDriveSignIn", async () => {
      await runGoogleDriveAuth(true);
    }),

    vscode.commands.registerCommand("vscodesync.googleDriveSignInHeadless", async () => {
      await runGoogleDriveAuth(false);
    }),

    vscode.commands.registerCommand("vscodesync.dropboxSignIn", async () => {
      await runDropboxAuth(true);
    }),

    vscode.commands.registerCommand("vscodesync.dropboxSignInHeadless", async () => {
      await runDropboxAuth(false);
    }),

    vscode.commands.registerCommand("vscodesync.yandexDiskSignIn", async () => {
      await runYandexDiskAuth(true);
    }),

    vscode.commands.registerCommand("vscodesync.yandexDiskSignInHeadless", async () => {
      await runYandexDiskAuth(false);
    }),

    vscode.commands.registerCommand("vscodesync.yandexDiskEnterToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "VSCodeSync: Яндекс Диск — ввод токена вручную",
        prompt: "Вставьте OAuth-токен (AQA…). Получить: oauth.yandex.ru → ваше приложение → «Получить OAuth-токен»",
        password: true,
        placeHolder: "AQAAAABxxxxxxxx…",
        validateInput: (v) => (v.trim().length < 10 ? "Слишком короткий токен" : undefined),
      });
      if (!token?.trim()) return;
      const { storeYandexTokens } = await import("./providers/yandex/yandexTokens.js");
      await storeYandexTokens(context.secrets, {
        accessToken: token.trim(),
        expiresAtMs: Date.now() + 365 * 24 * 3600 * 1000, // отладочный токен не истекает
      });
      await globalConfig.set("activeProvider", "yandex");
      await globalConfig.save();
      workspacesTree.setActiveCloudProvider("yandex");
      await vscode.window.showInformationMessage("Яндекс Диск: токен сохранён.");
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }),

    vscode.commands.registerCommand("vscodesync.resolveKeepMine", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const cfg = await WorkspaceConfigManager.load(target.root);
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      let touched = false;
      for (const f of cfg.files) {
        if (f.localPath === rel) {
          f.syncStatus = "ok";
          touched = true;
        }
      }
      if (!touched) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
        return;
      }
      await WorkspaceConfigManager.save(cfg, target.root);
      await vscode.window.showInformationMessage("Флаг конфликта снят; при необходимости выполните Push.");
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      void refreshActiveEditorSyncContext();
    }),

    vscode.commands.registerCommand("vscodesync.startOnboarding", async () => {
      await runOnboardingWizard(globalConfig, onboardingCloudDeps);
      await statusBar.refresh();
      workspacesTree.refresh();
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
      const cutoff = Date.now() - threshDays * 24 * 60 * 60 * 1000;
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
        for (const ws of wc.activeWorkspaces) {
          const lastSyncMs = newestTrackedLastSyncMs(wc, ws.workspaceId);
          if (lastSyncMs !== undefined && lastSyncMs < cutoff) {
            const daysSince = Math.floor((Date.now() - lastSyncMs) / 86400000);
            const choice = await vscode.window.showWarningMessage(
              `VSCodeSync ⏰ Workspace «${ws.workspaceNote || ws.workspaceId}» не синхронизировался ${String(daysSince)} дней.`,
              "Preview изменений",
              "Синхронизировать",
              "Пропустить",
            );
            if (choice === "Синхронизировать") {
              await vscode.commands.executeCommand("vscodesync.pullAll");
            } else if (choice === "Preview изменений") {
              await vscode.commands.executeCommand("vscodesync.previewSync");
            }
            break; // one notification per folder per session
          }
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

  // Command: copy a share-link for the current workspace to clipboard.
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.shareWorkspaceLink", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) return;
      const wc = await WorkspaceConfigManager.load(folders[0].uri.fsPath);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace для расшаривания.");
        return;
      }
      const pick = wc.activeWorkspaces.length === 1
        ? wc.activeWorkspaces[0]
        : await vscode.window.showQuickPick(
            wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, description: w.workspaceId, w })),
            { placeHolder: "Workspace для расшаривания" },
          ).then((p) => p?.w);
      if (!pick) return;
      const gc = await globalConfig.load();
      const provider = gc.activeProvider ?? "onedrive";
      const link = `vscode://borodatych.vscodesyncfiles/connect?provider=${encodeURIComponent(provider)}&workspaceId=${encodeURIComponent(pick.workspaceId)}`;
      await vscode.env.clipboard.writeText(link);
      await vscode.window.showInformationMessage(
        `VSCodeSync: link скопирован в буфер обмена. Откройте его на другой машине, чтобы подключить workspace «${pick.workspaceNote}».`,
      );
    }),
  );

  // Activity-feed saved searches and panel webviews — registered via per-area
  // command modules (см. v2.6 декомпозицию `extension.ts`).
  context.subscriptions.push(
    ...registerActivitySearchCommands({ context }),
    ...registerPanelCommands({ context, storageDir: globalConfig.getStorageDir() }),

    vscode.commands.registerCommand("vscodesync.pinFileForSync", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme !== "file") {
        await vscode.window.showWarningMessage("VSCodeSync: откройте файл для pin.");
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (!folder) return;
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      const rel = path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join("/");
      const tf = wc.files.find((f) => f.localPath === rel);
      if (!tf) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: файл не отслеживается — добавьте его в workspace.",
        );
        return;
      }
      await offlineQueueStore.enqueuePush(folder.uri.fsPath, rel, tf.workspaceId, true);
      await vscode.window.showInformationMessage(
        `VSCodeSync: «${rel}» закреплён в начале очереди — выгрузится первым при следующем flush.`,
      );
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
      for (const aw of wc.activeWorkspaces) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          const { createWorkspaceSnapshot } = await import("./core/snapshotsEngine.js");
          await createWorkspaceSnapshot(provider, folderRoot, aw.workspaceId, `auto-${stamp}`, gc.machineName);
        } catch {
          /* non-fatal — surfaces in next manual snapshot */
        }
      }
    },
  });
}

export function deactivate(): void {
  void disposeWorkspaceInstanceLock();
  disposeAllGlobalQueues();
}
