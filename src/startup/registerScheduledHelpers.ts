/**
 * Scheduled startup helpers — extracted from `extension.ts` (Phase 0 / v2.11.3).
 *
 * Bundles five startup-time orchestrations that share the
 * `VSCodeSync · Startup` OutputChannel:
 *   - `scheduleStartupSyncSummary` — initial pull-and-summarise.
 *   - Long-absence warning (last sync > N days).
 *   - Token-expiry warning (OneDrive only).
 *   - `scheduleWorkspaceInactiveArchivePrompt` — auto-archive prompt.
 *   - `scheduleSmartWorkspaceSuggestions` — heuristic workspace suggestions.
 *   - `scheduleMachineApprovalNotifier` — pending-machine approval toast.
 *
 * Side-effects, deferral conditions, and error surfaces all match the
 * previous inline activate() block.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import type { SyncScheduleDeferredStore } from "../core/syncScheduleDeferredStore.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { tryAuthenticatedProvider } from "../commands/_providerFactory.js";
import { scheduleStartupSyncSummary } from "../ui/syncSummaryStartup.js";
import { scheduleWorkspaceInactiveArchivePrompt } from "../ui/workspaceInactiveArchive.js";
import { scheduleSmartWorkspaceSuggestions } from "../ui/smartWorkspaceSuggestions.js";
import { scheduleMachineApprovalNotifier } from "../ui/machineApprovalNotifications.js";
import { applyArchivedTagAndSuspend } from "../ui/workspaceArchiveOps.js";
import { newestTrackedLastSyncMs } from "../utils/workspaceLastActivity.js";
import { evaluateLongAbsence, type LongAbsenceWorkspaceInput } from "../core/longAbsenceEvaluator.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { isAutoFullSyncEnabled, parseAutoSyncMode } from "../core/autoSyncMode.js";
import { isAutoSyncBlockedBySchedule } from "../ui/syncScheduleGate.js";
import { guardPathsBeforeAdd } from "../ui/syncGuards.js";
import { refreshActiveEditorSyncContext } from "../ui/editorSyncContext.js";
import { readOneDriveTokenBundle } from "../providers/onedrive/onedriveProvider.js";
import { classifyExpiry, formatExpiryHint } from "../core/tokenExpiryHints.js";
import { verboseLog } from "../utils/log.js";

const CFG_SECTION = "vscodesync";

export interface ScheduledHelpersDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  statusBar: SyncStatusBarController;
  workspacesTree: WorkspacesTreeProvider;
  fileDecorations: SyncFileDecorationController;
  scheduleDeferredStore: SyncScheduleDeferredStore;
  makeEngine: (
    root: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
}

export interface ScheduledHelpersHandle {
  startupChannel: vscode.OutputChannel;
}

export function registerScheduledHelpers(deps: ScheduledHelpersDeps): ScheduledHelpersHandle {
  const {
    context,
    globalConfig,
    registry,
    statusBar,
    workspacesTree,
    fileDecorations,
    scheduleDeferredStore,
    makeEngine,
  } = deps;

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
      // v0.7 — startup pull is an *automatic* action: only run when
      // `autoSyncMode = full`. In check-only / off, fall back to a status
      // refresh so the tree still shows what's stale, but no file moves.
      const autoMode = parseAutoSyncMode(
        vscode.workspace.getConfiguration(CFG_SECTION).get<string>("autoSyncMode", "check-only"),
      );
      const provider = await tryAuthenticatedProvider(registry);
      if (!provider) {
        return;
      }
      const cfg = await globalConfig.load();
      const engine = makeEngine(folderRoot, provider, cfg.machineId, cfg.machineName, "auto");
      verboseLog("startup", `pullAll START ${folderRoot} mode=${autoMode}`);
      statusBar.setSyncing(true);
      try {
        if (isAutoFullSyncEnabled(autoMode)) {
          await engine.pullAll();
        } else if (autoMode === "check-only") {
          // Status-only refresh — no files overwritten.
          const wc = await WorkspaceConfigManager.load(folderRoot);
          for (const aw of wc.activeWorkspaces) {
            await engine.checkWorkspaceStatus(aw.workspaceId);
          }
        }
        // autoMode === "off": skip entirely.
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
  // close to it (7-day soft warning via classifyExpiry). OneDrive only — others auto-refresh.
  void (async () => {
    try {
      const gc = await globalConfig.load();
      if (!gc.activeProvider) {
        return;
      }
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
      // The prompt is scheduled, but this hook runs only after the user chose
      // to archive — `workspaceInactiveArchive.ts:118`.
      const engine = makeEngine(folderRootFsPath, provider, gc.machineId, gc.machineName, "user");
      statusBar.setSyncing(true);
      try {
        await applyArchivedTagAndSuspend(engine, workspaceId);
        void vscode.window.showInformationMessage(
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
      // Reached only after the user typed a workspace name in the suggestion
      // prompt — `smartWorkspaceSuggestions.ts:168`.
      const engine = makeEngine(folderRoot, provider, gc.machineId, gc.machineName, "user");
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
      // Same shape as `onArchive`: the user picked the archive option —
      // `smartWorkspaceSuggestions.ts:230`.
      const engine = makeEngine(folderRootFsPath, provider, gc.machineId, gc.machineName, "user");
      statusBar.setSyncing(true);
      try {
        await applyArchivedTagAndSuspend(engine, workspaceId);
        void vscode.window.showInformationMessage(
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
    makeEngine,
    startupChannel,
  });

  return { startupChannel };
}
