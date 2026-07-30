import type { WorkspaceFolder } from "vscode";
import type { ProviderType } from "../core/types.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { SyncEngine } from "../core/syncEngine.js";
import { STALE_MANIFEST_EDITING_LOCK_MS } from "../core/syncEngine.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { readMachinesRegistrySafe } from "../core/machineRegistry.js";
import { setLastHealthReport } from "../core/lastHealthReportStore.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import type { SyncScheduleDeferredStore } from "../core/syncScheduleDeferredStore.js";
import { describeWorkspaceInstanceLockForHealth } from "../core/workspaceInstanceLock.js";
import { workspaceHealthEmoji, workspaceHealthFromLocalCfg } from "./workspaceHealthLocal.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "../core/syncWorkspaceInstanceReadOnly.js";

const DAY_MS = 24 * 3600_000;

function providerLabel(type: ProviderType | null): string {
  switch (type) {
    case "onedrive":
      return "OneDrive";
    case "gdrive":
      return "Google Drive";
    case "yandex":
      return "Yandex Disk";
    case "dropbox":
      return "Dropbox";
    default:
      return "—";
  }
}

export interface StaleLockTarget {
  folderRoot: string;
  workspaceId: string;
  workspaceNote: string;
}

export interface HealthCheckReport {
  lines: string[];
  staleLockTargets: StaleLockTarget[];
  machinesRegistryStale: boolean;
}

export async function buildHealthCheckReport(ctx: {
  workspaceFolders: readonly WorkspaceFolder[];
  globalConfig: GlobalConfigManager;
  activeProviderType: ProviderType | null;
  provider: ICloudProvider | null;
  machineId: string;
  machineName: string;
  createEngine: (folderRoot: string, cloud: ICloudProvider) => SyncEngine;
  offlineQueue: SyncOfflineQueueStore;
  scheduleDeferred: SyncScheduleDeferredStore;
}): Promise<HealthCheckReport> {
  const lines: string[] = [];
  const staleLockTargets: StaleLockTarget[] = [];
  const staleSeen = new Set<string>();
  let machinesRegistryStale = false;

  const stamp = new Date().toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
  lines.push(`VSCodeSync Health Check — ${stamp}`);
  lines.push("");

  const gcMgr = ctx.globalConfig;
  const storageDir = gcMgr.getStorageDir();
  const roots = ctx.workspaceFolders.map((f) => f.uri.fsPath);
  lines.push(
    ctx.provider
      ? `✅ ${providerLabel(ctx.activeProviderType)}: подключен (авторизация OK)`
      : `❌ Провайдер ${providerLabel(ctx.activeProviderType)}: нет активной сессии — выполните вход`,
  );

  if (ctx.provider) {
    const reg = await readMachinesRegistrySafe(ctx.provider);
    if (reg === undefined) {
      lines.push("⚠ _machines.json: не удалось прочитать (сеть или права)");
    } else {
      const self = reg.find((e) => e.machineId === ctx.machineId);
      if (!self) {
        lines.push(`⚠ _machines.json: машина «${ctx.machineName}» отсутствует в реестре — при следующем sync запись появится`);
        machinesRegistryStale = true;
      } else {
        const t = Date.parse(self.lastSeen);
        if (Number.isNaN(t)) {
          lines.push("⚠ _machines.json: у локальной машины некорректная дата lastSeen");
        } else if (Date.now() - t > DAY_MS) {
          lines.push(
            `❌ _machines.json: lastSeen для этой машины старше 24 ч (${self.lastSeen}) — обновите реестр`,
          );
          machinesRegistryStale = true;
        } else {
          lines.push(`✅ _machines.json: запись этой машины актуальна (lastSeen ${self.lastSeen})`);
        }
      }
    }
  }

  const offlineN = await ctx.offlineQueue.totalPending();
  lines.push(offlineN === 0 ? "✅ Оффлайн-очередь: пуста" : `⚠ Оффлайн-очередь: ${String(offlineN)} операций в queue.json`);

  const defN = await ctx.scheduleDeferred.totalPending();
  lines.push(
    defN === 0
      ? "✅ Отложенные операции (расписание): нет"
      : `⚠ Отложенные операции (расписание): ${String(defN)} в очереди`,
  );

  lines.push(await describeWorkspaceInstanceLockForHealth(storageDir, roots));
  if (isSecondaryWorkspaceInstanceReadOnly()) {
    lines.push("⚠ Это окно VSCode в режиме read-only (вторичный инстанс): push и запись манифеста заблокированы");
  }

  lines.push(
    `Мягкий lock в манифесте считается устаревшим если editingSince старше ${String(
      Math.round(STALE_MANIFEST_EDITING_LOCK_MS / 3600_000),
    )} ч`,
  );
  lines.push("");

  for (const folder of ctx.workspaceFolders) {
    const root = folder.uri.fsPath;
    const wc = await WorkspaceConfigManager.load(root);
    if (wc.activeWorkspaces.length === 0) {
      lines.push(`— ${folder.name} — нет активных workspace`);
      lines.push("");
      continue;
    }
    lines.push(`— ${folder.name} (${root}) —`);
    if (!ctx.provider) {
      for (const aw of wc.activeWorkspaces) {
        const local = workspaceHealthFromLocalCfg(wc, aw.workspaceId);
        const st = normalizeWorkspaceSyncState(aw);
        const stLine =
          st !== "active" ? ` [syncState: ${st}]` : "";
        lines.push(
          `${workspaceHealthEmoji(local.level)} «${aw.workspaceNote}» (${aw.workspaceId})${stLine} — облако не проверялось (нет провайдера)`,
        );
        for (const s of local.summaryLines) {
          lines.push(`    · ${s}`);
        }
      }
      lines.push("");
      continue;
    }

    const engine = ctx.createEngine(root, ctx.provider);
    for (const aw of wc.activeWorkspaces) {
      const local = workspaceHealthFromLocalCfg(wc, aw.workspaceId);
      const st = normalizeWorkspaceSyncState(aw);
      const stLine = st !== "active" ? ` [syncState: ${st}]` : "";
      const cloud = await engine.healthCheckWorkspace(aw.workspaceId);
      const trackedN = wc.files.filter((f) => f.workspaceId === aw.workspaceId).length;
      const cloudPart = cloud.ok
        ? `манифест OK, ${String(trackedN)} файл(ов) в локальном трекинге`
        : `манифест: ${cloud.message}`;
      lines.push(
        `${workspaceHealthEmoji(local.level)} «${aw.workspaceNote}» (${aw.workspaceId})${stLine} — ${cloudPart}`,
      );
      for (const s of local.summaryLines) {
        lines.push(`    · ${s}`);
      }
      const stale = await engine.listStaleManifestEditingLocks(aw.workspaceId);
      for (const row of stale) {
        lines.push(
          `    ⚠ stale soft lock: ${row.path} («${row.editingBy}», ~${row.ageHours.toFixed(1)} ч.)`,
        );
      }
      if (stale.length > 0) {
        const key = `${root}\u0000${aw.workspaceId}`;
        if (!staleSeen.has(key)) {
          staleSeen.add(key);
          staleLockTargets.push({
            folderRoot: root,
            workspaceId: aw.workspaceId,
            workspaceNote: aw.workspaceNote,
          });
        }
      }
    }
    lines.push("");
  }

  // Recorded here rather than at each call site so no caller can forget: the
  // support bundle reads this back, and the report itself only ever went to a
  // write-only output channel.
  setLastHealthReport(lines);
  return { lines, staleLockTargets, machinesRegistryStale };
}
