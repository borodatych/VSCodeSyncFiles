/**
 * Diagnostic command bundle — 14th tranche of the `extension.ts`
 * decomposition (v2.6.5 finishing).
 *
 * Holds the 2 diagnostic palette commands:
 *   - takeSyncOwnership: takes the workspace-instance lock from another
 *     VS Code window (forces this window to be primary).
 *   - healthCheck: runs `buildHealthCheckReport`, prints to a dedicated
 *     OutputChannel, then offers actionable repairs (refresh
 *     _machines.json, clear stale soft locks).
 *
 * Both have heavy deps surfaces so they get one shared bundle (rather
 * than fitting the existing `_shared.ts` patterns). All 87 of the
 * original extension.ts commands extracted after this wave EXCEPT
 * createWorkspace and connectCloudWorkspace (next bundle).
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { syncMachinesRegistrySelf } from "../core/machineRegistry.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import {
  forceAcquireWorkspaceInstanceLock,
  peekWorkspaceInstanceLockHolder,
} from "../core/workspaceInstanceLock.js";
import { buildHealthCheckReport } from "../ui/healthCheckReport.js";
import { formatBytes } from "../core/storageUsageReport.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import {
  buildSyncProfileReport,
  type SyncProfileBuffer,
} from "../core/syncProfileBuffer.js";

export interface DiagnosticsCommandsDeps {
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  offlineQueueStore: SyncOfflineQueueStore;
  healthCheckChannel: vscode.OutputChannel;
  refreshWorkspaceInstanceLock: () => void;
  /** Auth-aware lookup of the active provider; returns null when not signed in. */
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  /** Encryption key resolver; returns null when encryption is off. */
  /** Engine factory used by Health Check to run targeted ops without going
   * through the full `runWithEngine` flow. */
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
  /** Open VS Code folder list — usually `vscode.workspace.workspaceFolders ?? []`. */
  roots: () => readonly vscode.WorkspaceFolder[];
  /** v0.7 — profile buffer shared with the engine factory. */
  profileBuffer: SyncProfileBuffer;
}

export function registerDiagnosticsCommands(
  deps: DiagnosticsCommandsDeps,
): vscode.Disposable[] {
  const {
    globalConfig,
    registry,
    offlineQueueStore,
    healthCheckChannel,
    refreshWorkspaceInstanceLock,
    tryAuthenticatedProvider,
    makeEngine,
    roots,
    profileBuffer,
  } = deps;
  void registry;
  const profileChannel = vscode.window.createOutputChannel("VSCodeSync · Profile");

  return [
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
      const gc = await globalConfig.load();
      await forceAcquireWorkspaceInstanceLock(storageDir, currentRoots, gc.machineName);
      refreshWorkspaceInstanceLock();
      void vscode.window.showInformationMessage("VSCodeSync: это окно теперь основное. Push доступен.");
    }),

    vscode.commands.registerCommand("vscodesync.healthCheck", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync Health: откройте папку workspace.");
        return;
      }
      const provider = await tryAuthenticatedProvider();
      const gcData = await globalConfig.load();
      const report = await buildHealthCheckReport({
        workspaceFolders: folders,
        globalConfig,
        activeProviderType: gcData.activeProvider,
        provider,
        machineId: gcData.machineId,
        machineName: gcData.machineName,
        createEngine: (root, p) => makeEngine(root, p, gcData.machineId, gcData.machineName, "user"),
        offlineQueue: offlineQueueStore,
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
      if (report.duplicateLinkIdTargets.length > 0 && provider) {
        actions.push("Починить дубликаты linkId");
      }
      if (provider) {
        actions.push("Проверить мусор в облаке");
      }
      actions.push("Закрыть");

      const picked = await vscode.window.showInformationMessage(
        "VSCodeSync Health Check — открыта панель Output. Изменения в облаке только по кнопкам ниже.",
        ...actions,
      );

      if (picked === "Обновить _machines.json" && provider) {
        try {
          await syncMachinesRegistrySelf(provider, gcData.machineId, gcData.machineName);
          void vscode.window.showInformationMessage("VSCodeSync: _machines.json обновлён (запись этой машины).");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await vscode.window.showErrorMessage(`VSCodeSync: не удалось обновить реестр — ${msg}`);
        }
      }

      if (picked === "Починить stale lock" && provider) {
        let total = 0;
        for (const t of report.staleLockTargets) {
          try {
            const eng = makeEngine(t.folderRoot, provider, gcData.machineId, gcData.machineName, "user");
            total += await eng.clearStaleManifestEditingLocks(t.workspaceId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await vscode.window.showErrorMessage(`VSCodeSync: починка stale lock — ${t.workspaceNote}: ${msg}`);
            total = -1;
            break;
          }
        }
        if (total > 0) {
          void vscode.window.showInformationMessage(
            `VSCodeSync: сброшено устаревших soft lock в манифесте: ${String(total)}`,
          );
        }
        if (total === 0 && report.staleLockTargets.length > 0) {
          void vscode.window.showInformationMessage(
            "VSCodeSync: устаревших soft lock не осталось (уже сброшены или порог времени изменился). Перезапустите Health Check.",
          );
        }
      }

      if (picked === "Починить дубликаты linkId" && provider) {
        let groups = 0;
        for (const t of report.duplicateLinkIdTargets) {
          try {
            const eng = makeEngine(t.folderRoot, provider, gcData.machineId, gcData.machineName, "user");
            groups += await eng.repairWorkspaceDuplicateLinkIds(t.workspaceId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await vscode.window.showErrorMessage(`VSCodeSync: ремонт дубликатов — ${t.workspaceNote}: ${msg}`);
            groups = -1;
            break;
          }
        }
        if (groups > 0) {
          void vscode.window.showInformationMessage(
            `VSCodeSync: починено групп дубликатов linkId: ${String(groups)}. Выживает новейший носитель, привязки слиты.`,
          );
        }
        if (groups === 0 && report.duplicateLinkIdTargets.length > 0) {
          void vscode.window.showInformationMessage(
            "VSCodeSync: дубликатов не осталось (уже починены — например, авторемонтом при слиянии). Перезапустите Health Check.",
          );
        }
      }

      // Orphan GC: scan on demand (a recursive listing costs API quota, so it
      // does not ride every weekly auto-check), then trash strictly after an
      // explicit confirmation. deleteFile = provider trash (contract D11).
      if (picked === "Проверить мусор в облаке" && provider) {
        const scans: {
          folderRoot: string;
          workspaceId: string;
          workspaceNote: string;
          plan: Awaited<ReturnType<SyncEngine["scanWorkspaceOrphansForGc"]>>;
        }[] = [];
        for (const folder of folders) {
          const root = folder.uri.fsPath;
          const wc = await WorkspaceConfigManager.load(root);
          for (const aw of wc.activeWorkspaces) {
            try {
              const eng = makeEngine(root, provider, gcData.machineId, gcData.machineName, "user");
              const plan = await eng.scanWorkspaceOrphansForGc(aw.workspaceId);
              scans.push({ folderRoot: root, workspaceId: aw.workspaceId, workspaceNote: aw.workspaceNote, plan });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              healthCheckChannel.appendLine(`⚠ GC-скан «${aw.workspaceNote}»: ${msg}`);
            }
          }
        }
        let objects = 0;
        let bytes = 0;
        let undatable = 0;
        for (const s of scans) {
          const n = s.plan.orphanBlobs.length + s.plan.orphanHistoryFiles.length;
          objects += n;
          bytes += s.plan.totalBytes;
          undatable += s.plan.skippedUndatable.length;
          healthCheckChannel.appendLine(
            `— GC «${s.workspaceNote}»: сирот ${String(n)} (${formatBytes(s.plan.totalBytes)}), ` +
              `лишних строк _meta ${String(s.plan.orphanMetaKeys.length)}, без даты (пропущены): ${String(s.plan.skippedUndatable.length)}`,
          );
          for (const o of [...s.plan.orphanBlobs, ...s.plan.orphanHistoryFiles]) {
            healthCheckChannel.appendLine(`    · ${o.cloudPath}`);
          }
        }
        const metaRows = scans.reduce((n, s) => n + s.plan.orphanMetaKeys.length, 0);
        if (objects === 0 && metaRows === 0) {
          void vscode.window.showInformationMessage(
            `VSCodeSync: мусора не найдено${undatable > 0 ? ` (объектов без даты, пропущено: ${String(undatable)})` : ""}.`,
          );
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `VSCodeSync: найдено сирот: ${String(objects)} (${formatBytes(bytes)}) и лишних строк _meta: ${String(metaRows)}. ` +
            "Список — в панели Output. Переместить в корзину провайдера?",
          { modal: true },
          "Собрать в корзину",
        );
        if (confirm !== "Собрать в корзину") {
          return;
        }
        let freed = 0;
        let deleted = 0;
        for (const s of scans) {
          try {
            const eng = makeEngine(s.folderRoot, provider, gcData.machineId, gcData.machineName, "user");
            const res = await eng.collectWorkspaceOrphansToTrash(s.workspaceId, s.plan);
            freed += res.freedBytes;
            deleted += res.deletedObjects;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await vscode.window.showErrorMessage(`VSCodeSync: GC «${s.workspaceNote}»: ${msg}`);
          }
        }
        void vscode.window.showInformationMessage(
          `VSCodeSync: в корзину провайдера отправлено объектов: ${String(deleted)}, освобождено ${formatBytes(freed)}.`,
        );
      }
    }),

    vscode.commands.registerCommand("vscodesync.profileSync", () => {
      const enabled = vscode.workspace
        .getConfiguration("vscodesync")
        .get<boolean>("diagnostics.profileSync", false);
      const snap = profileBuffer.snapshot();
      const lines = buildSyncProfileReport(snap, 15);
      profileChannel.clear();
      if (!enabled) {
        profileChannel.appendLine(
          "VSCodeSync · Profile: настройка vscodesync.diagnostics.profileSync = false — сбор отключён.",
        );
        profileChannel.appendLine(
          "Включите её, выполните push/pull/sync и повторите эту команду.",
        );
        profileChannel.appendLine("");
      }
      for (const ln of lines) {
        profileChannel.appendLine(ln);
      }
      profileChannel.show(true);
    }),

    new vscode.Disposable(() => {
      profileChannel.dispose();
    }),
  ];
}
