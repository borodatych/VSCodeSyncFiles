import * as vscode from "vscode";
import * as path from "node:path";
import type { ProviderType, WorkspaceConfig } from "../core/types.js";
import { EXTENSION_SETTINGS_QUERY } from "../core/extensionIdentity.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { describeScheduleActiveHint } from "../core/syncSchedule.js";
import { getWorkspaceSyncScheduleNormalized, isAutoSyncBlockedBySchedule } from "./syncScheduleGate.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "../core/syncWorkspaceInstanceReadOnly.js";
import {
  getRateLimitRemainingMs,
  isAutoSyncBlockedByRateLimit,
  subscribeRateLimit,
} from "../core/syncRateLimitState.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { hasStickyUnreachableHint, subscribeOfflineHints } from "../core/syncOfflineHints.js";
import { readPassiveOnlineHint } from "../utils/readNavigatorOnline.js";
import { loadActivityFile } from "../core/activityLog.js";
import { sparkline, bucketHourly } from "../utils/sparkline.js";
import { parseAutoSyncMode } from "../core/autoSyncMode.js";
import { warnLog } from "../utils/log.js";

/**
 * If the "syncing" depth stays positive this long, some caller incremented it
 * and never decremented. Sitting on a permanent spinner is exactly what the
 * extension looked like when it hung, so the depth is force-reset and logged.
 * Comfortably above the file-lock hold deadline, so a legitimately slow
 * operation is never cut short by this.
 */
const SYNCING_WATCHDOG_MS = 10 * 60_000;

function autoSyncModeBadge(mode: ReturnType<typeof parseAutoSyncMode>): string {
  switch (mode) {
    case "off":
      return "$(eye-closed) auto:off";
    case "check-only":
      return "$(eye) auto:check";
  }
}

const SPARKLINE_TTL_MS = 60_000;
let sparkCache: { storageDir: string; computedAt: number; text: string } | undefined;

async function buildSparkSuffix(storageDir: string): Promise<string> {
  if (
    sparkCache?.storageDir === storageDir &&
    Date.now() - sparkCache.computedAt < SPARKLINE_TTL_MS
  ) {
    return sparkCache.text;
  }
  let text = "";
  try {
    const file = await loadActivityFile(storageDir);
    const stamps: number[] = [];
    for (const ev of file.events) {
      if (ev.kind !== "push" && ev.kind !== "pull") continue;
      const t = Date.parse(ev.at);
      if (Number.isFinite(t)) stamps.push(t);
    }
    if (stamps.length > 0) {
      const buckets = bucketHourly(stamps, Date.now(), 24);
      const spark = sparkline(buckets);
      if (spark.trim().length > 0) text = `  · ${spark}`;
    }
  } catch {
    // Activity log may not exist yet (pre-first-event) — silent fallback.
  }
  sparkCache = { storageDir, computedAt: Date.now(), text };
  return text;
}

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

function formatLastSync(iso: string | undefined): string {
  if (!iso) {
    return "—";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  // Explicit 24h HH:MM — avoids AM/PM creeping into locales that toLocaleTimeString
  // formats with 12h by default (e.g. ru-RU on some platforms).
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export interface SyncStatusBarDeps {
  globalConfig: GlobalConfigManager;
  /** Вызывается при смене флага синхронизации (декорации «🔄»). */
  onSyncingChange?: (syncing: boolean) => void;
  /** Deferred ops while outside `syncSchedule` window (pending count in status bar). */
  scheduleDeferredStore?: import("../core/syncScheduleDeferredStore.js").SyncScheduleDeferredStore;
  /** Transport-failed sync ops persisted for flush when online. */
  offlineQueue?: SyncOfflineQueueStore;
}

interface FolderWorkspaceState {
  folder: vscode.WorkspaceFolder;
  wc: WorkspaceConfig;
}

export class SyncStatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Long-lived subscriptions (not per-workspace-folder). */
  private readonly disposables: vscode.Disposable[] = [];
  /** Watchers for `.vscode/vscodesync.json` per folder — rebound on workspace folder changes. */
  private workspaceJsonWatchDisposables: vscode.Disposable[] = [];
  /**
   * Nesting depth of "sync in progress", not a flag.
   *
   * Seven independent call sites toggle this — commands, save triggers, offline
   * flush, schedule flush, quiet full sync, scheduled helpers — and with a plain
   * boolean whichever finished first switched the spinner off for everyone else
   * (and, symmetrically, could leave it on after everything had finished).
   */
  private syncingDepth = 0;
  /** Fires when the depth stays positive implausibly long — see `armSyncingWatchdog`. */
  private syncingWatchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: SyncStatusBarDeps) {
    this.item = vscode.window.createStatusBarItem("vscodesync.syncStatus", vscode.StatusBarAlignment.Left, 100);
    // §624 — the status bar is the entry point to the divergences panel: it
    // shows the counts, the panel shows what they are and lets the user act.
    this.item.command = "vscodesync.openDivergences";
    this.item.tooltip = "VSCodeSync · клик — показать расхождения";

    this.rebindWorkspaceJsonWatchers();

    const pauseSub = syncSessionPause.subscribe(() => {
      void this.refresh();
    });

    const autoPauseSub = syncAutoPause.subscribe(() => {
      void this.refresh();
    });

    const rateLimitSub = subscribeRateLimit(() => {
      void this.refresh();
    });
    const uiTick = setInterval(() => {
      void (async () => {
        const needRateTick = isAutoSyncBlockedByRateLimit();
        const n = this.deps.offlineQueue ? await this.deps.offlineQueue.totalPending() : 0;
        if (needRateTick || n > 0 || hasStickyUnreachableHint()) {
          void this.refresh();
        }
      })();
    }, 1000);

    const offlineHintSub = subscribeOfflineHints(() => {
      void this.refresh();
    });

    this.disposables.push(
      new vscode.Disposable(() => {
        pauseSub.dispose();
      }),
      new vscode.Disposable(() => {
        autoPauseSub.dispose();
      }),
      new vscode.Disposable(() => {
        rateLimitSub.dispose();
      }),
      new vscode.Disposable(() => { clearInterval(uiTick); }),
      new vscode.Disposable(() => {
        offlineHintSub.dispose();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rebindWorkspaceJsonWatchers();
        void this.refresh();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const norm = doc.uri.fsPath.replace(/\\/g, "/").toLowerCase();
        if (norm.endsWith("/.vscode/vscodesync.json")) {
          void this.refresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("vscodesync.autoSyncMode")) {
          void this.refresh();
        }
      }),
    );

    const gcfgPath = this.deps.globalConfig.getConfigPath();
    const gcfgDir = vscode.Uri.file(path.dirname(gcfgPath));
    const gcfgWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gcfgDir, path.basename(gcfgPath)),
    );
    this.disposables.push(
      gcfgWatcher,
      gcfgWatcher.onDidChange(() => {
        this.deps.globalConfig.invalidateCache();
        void this.refresh();
      }),
      gcfgWatcher.onDidCreate(() => {
        this.deps.globalConfig.invalidateCache();
        void this.refresh();
      }),
    );

    void this.refresh();
  }

  private rebindWorkspaceJsonWatchers(): void {
    for (const d of this.workspaceJsonWatchDisposables) {
      d.dispose();
    }
    this.workspaceJsonWatchDisposables = [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(folder, ".vscode/vscodesync.json");
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      this.workspaceJsonWatchDisposables.push(
        w,
        w.onDidChange(() => void this.refresh()),
        w.onDidCreate(() => void this.refresh()),
        w.onDidDelete(() => void this.refresh()),
      );
    }
  }

  setSyncing(on: boolean): void {
    const was = this.syncingDepth > 0;
    this.syncingDepth = on ? this.syncingDepth + 1 : Math.max(0, this.syncingDepth - 1);
    const now = this.syncingDepth > 0;
    this.armSyncingWatchdog(now);
    if (was !== now) {
      this.deps.onSyncingChange?.(now);
    }
    void this.refresh();
  }

  /**
   * Backstop against a caller that increments and never decrements — a `finally`
   * that never runs leaves the status bar claiming "Синхронизация…" forever,
   * which is exactly what the extension looked like when it hung.
   */
  private armSyncingWatchdog(active: boolean): void {
    if (this.syncingWatchdog !== undefined) {
      clearTimeout(this.syncingWatchdog);
      this.syncingWatchdog = undefined;
    }
    if (!active) return;
    this.syncingWatchdog = setTimeout(() => {
      warnLog(
        "statusBar",
        `spinner stuck for ${String(SYNCING_WATCHDOG_MS)}ms with depth=${String(this.syncingDepth)} — forcing reset`,
      );
      this.syncingDepth = 0;
      this.syncingWatchdog = undefined;
      this.deps.onSyncingChange?.(false);
      void this.refresh();
    }, SYNCING_WATCHDOG_MS);
  }

  private async loadAllFolderStates(): Promise<FolderWorkspaceState[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const out: FolderWorkspaceState[] = [];
    for (const folder of folders) {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      out.push({ folder, wc });
    }
    return out;
  }

  async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.item.hide();
      return;
    }

    const gc = await this.deps.globalConfig.load();
    const providerType = gc.activeProvider;
    const plabel = providerLabel(providerType);
    const readOnlySecondary = isSecondaryWorkspaceInstanceReadOnly();
    const sessionPaused = syncSessionPause.isPaused();
    const pendingDuringPause = syncSessionPause.getPendingDocCount();
    let offlinePending = 0;
    if (this.deps.offlineQueue) {
      offlinePending = await this.deps.offlineQueue.totalPending();
    }
    const passiveOn = readPassiveOnlineHint();
    const offlineBadge =
      offlinePending > 0 || (hasStickyUnreachableHint() && !passiveOn);

    if (this.syncingDepth > 0) {
      this.item.text = `$(loading~spin) ${plabel}`;
      this.item.tooltip = "VSCodeSync · синхронизация…";
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
      this.item.show();
      return;
    }

    if (readOnlySecondary) {
      let text = "$(cloud) Read-only · sync в другом окне VSCode";
      let tip =
        "VSCodeSync: это окно только вытягивает изменения (Pull). Запись в облако отключена — lock держит другое окно VSCode с тем же workspace.\n\nКлик — стать основным окном синхронизации (принудительно освободить lock).";
      if (offlineBadge && offlinePending > 0) {
        text += `  · $(globe) Offline · ${String(offlinePending)} queued`;
        tip += `\n\n📡 В оффлайн-очереди: ${String(offlinePending)}.`;
      } else if (offlineBadge) {
        text += "  · $(globe) Offline";
        tip += `\n\n📡 Нет сети или обрыв связи с облаком.`;
      }
      this.item.text = text;
      this.item.tooltip = tip;
      this.item.command = "vscodesync.takeSyncOwnership";
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
      this.item.show();
      return;
    }
    this.item.command = "vscodesync.openDivergences";

    const loaded = await this.loadAllFolderStates();
    let wsCount = 0;
    let fileCount = 0;
    let conflicts = 0;
    let cloudNewer = 0;
    let last = "";
    for (const { wc } of loaded) {
      wsCount += wc.activeWorkspaces.length;
      fileCount += wc.files.length;
      conflicts += wc.files.filter((f) => f.syncStatus === "conflict").length;
      cloudNewer += wc.files.filter((f) => f.syncStatus === "cloud_newer").length;
      for (const f of wc.files) {
        if (f.lastSync && (!last || f.lastSync > last)) {
          last = f.lastSync;
        }
      }
    }
    const lastFmt = formatLastSync(last || undefined);

    const conflictSuffix =
      conflicts > 0 ? `  $(warning) ${String(conflicts)} conflict${conflicts === 1 ? "" : "s"}` : "";
    const cloudNewerSuffix =
      cloudNewer > 0 ? `  $(arrow-down) ${String(cloudNewer)}` : "";

    const autoPaused = !sessionPaused && syncAutoPause.isActive();
    const scheduleBlocked = !sessionPaused && !autoPaused && isAutoSyncBlockedBySchedule();
    const rateLimited = isAutoSyncBlockedByRateLimit();
    const rateSec = rateLimited ? Math.max(1, Math.ceil(getRateLimitRemainingMs() / 1000)) : 0;
    let deferredPending = 0;
    if (scheduleBlocked && this.deps.scheduleDeferredStore) {
      deferredPending = await this.deps.scheduleDeferredStore.totalPending();
    }

    const pausePrefix = sessionPaused
      ? "$(debug-pause) "
      : autoPaused
        ? "$(warning) "
        : scheduleBlocked
          ? "$(calendar) "
          : rateLimited
            ? "$(hourglass) "
            : "$(cloud) ";
    const pendingSuffix =
      sessionPaused && pendingDuringPause > 0
        ? `  · $(git-pull-request-pending) ${String(pendingDuringPause)} pending`
        : "";

    let autoPauseSuffix = "";
    if (autoPaused) {
      const ar = syncAutoPause.getReason();
      autoPauseSuffix =
        ar === "metered"
          ? `  · $(plug) авто-пауза · metered`
          : ar === "battery"
            ? `  · $(zap) авто-пауза · battery`
            : `  · авто-пауза`;
    }

    const scheduleHint = describeScheduleActiveHint(getWorkspaceSyncScheduleNormalized());
    let scheduleSuffix = "";
    if (scheduleBlocked) {
      scheduleSuffix = `  · $(clock) Scheduled pause · ${scheduleHint}`;
      if (deferredPending > 0) {
        scheduleSuffix += `  · $(git-pull-request-pending) ${String(deferredPending)} queued`;
      }
    }

    let rateSuffix = "";
    if (rateLimited) {
      rateSuffix = `  · $(watch) rate limit ~${String(rateSec)}s`;
    }

    // Watch Mode indicator with current interval
    let watchSuffix = "";
    const watchOn = vscode.workspace.getConfiguration("vscodesync").get<boolean>("watchMode", false);
    if (watchOn) {
      const { getCurrentWatchIntervalMs } = await import("./watchModePoller.js");
      const curMs = getCurrentWatchIntervalMs();
      const baseSec = vscode.workspace.getConfiguration("vscodesync").get<number>("watchIntervalSeconds", 30);
      const curSec = Math.round(curMs / 1000);
      if (curSec > baseSec * 1.5) {
        watchSuffix = `  · $(eye) Watch · ${curSec >= 60 ? `${String(Math.round(curSec / 60))}min` : `${String(curSec)}s`} (idle)`;
      } else {
        watchSuffix = `  · $(eye) Watch`;
      }
    }

    let offlineSuffix = "";
    if (offlineBadge && offlinePending > 0) {
      offlineSuffix = `  · $(globe) Offline · ${String(offlinePending)} queued`;
    } else if (offlineBadge) {
      offlineSuffix = "  · $(globe) Offline";
    }

    const sparkSuffix = await buildSparkSuffix(this.deps.globalConfig.getStorageDir());

    // v0.7 — surface autoSyncMode in the visible text. Tooltip already
    // explains modes, but the badge lets users see at a glance whether a
    // save will push or just be observed.
    const autoModeParsed = parseAutoSyncMode(
      vscode.workspace.getConfiguration("vscodesync").get<string>("autoSyncMode", "check-only"),
    );
    const autoModeBadge = `  · ${autoSyncModeBadge(autoModeParsed)}`;

    this.item.text = `${pausePrefix}${plabel}${autoModeBadge}  $(pass) ${String(wsCount)} ws · ${String(fileCount)} files${conflictSuffix}${cloudNewerSuffix}${pendingSuffix}${autoPauseSuffix}${scheduleSuffix}${rateSuffix}${watchSuffix}${offlineSuffix}${sparkSuffix}  $(clock) ${lastFmt}`;
    let tooltip =
      loaded.length === 1 && loaded[0]
        ? this.buildTooltip(loaded[0].wc, plabel, gc.activeProvider, sessionPaused)
        : this.buildMultiRootTooltip(loaded, plabel, gc.activeProvider, sessionPaused);
    if (autoPaused) {
      const ar = syncAutoPause.getReason();
      tooltip += `\n\n⚡ Авто-пауза: ${ar === "metered" ? "лимитированное соединение" : "низкий заряд батареи"}. Ручные команды доступны.`;
    }
    if (scheduleBlocked) {
      tooltip += `\n\n⏰ Scheduled pause — активное окно ${scheduleHint}. Автотриггеры отключены; очередь отложенных: ${String(deferredPending)}.`;
    }
    if (rateLimited) {
      tooltip += `\n\n⏳ Ответ провайдера 429/503 (throttle). Автосинк отложен ~${String(rateSec)} с. Ручные команды не блокируются.`;
    }
    if (offlinePending > 0 || hasStickyUnreachableHint()) {
      tooltip += `\n\n📡 Оффлайн-очередь: ${String(offlinePending)} операций (см. \`queue.json\`). Flush при восстановлении сети.`;
    }
    // v0.7 — show the current autoSyncMode so users understand why a save
    // didn't trigger a push (or why nothing automatic is happening).
    const autoMode = vscode.workspace
      .getConfiguration("vscodesync")
      .get<string>("autoSyncMode", "check-only");
    if (autoMode === "off") {
      tooltip += `\n\n🚦 Авто-режим: OFF — никакой автосинхронизации. Пользуйтесь Push / Pull / Sync вручную (vscodesync.cycleAutoSyncMode для смены).`;
    } else if (autoMode === "check-only") {
      tooltip += `\n\n🚦 Авто-режим: только проверка статусов. Push/Pull — только вручную (vscodesync.cycleAutoSyncMode для смены).`;
    } else {
      tooltip += `\n\n🚦 Авто-режим: полная синхронизация (push на save, pull на open).`;
    }
    this.item.tooltip = tooltip;
    if (conflicts > 0) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      this.item.backgroundColor = undefined;
    }
    this.item.color = undefined;
    this.item.show();
  }

  private buildTooltip(
    wc: WorkspaceConfig,
    providerLabelText: string,
    providerType: ProviderType | null,
    syncPaused: boolean,
  ): string {
    const lines: string[] = [`VSCodeSync · ${providerLabelText}`];
    if (syncPaused) {
      lines.push("⏸ Синхронизация на паузе — Resume / Toggle Pause.");
      lines.push("");
    }
    if (wc.activeWorkspaces.length === 0) {
      lines.push("Нет активных workspace — создайте через Command Palette.");
      return lines.join("\n");
    }
    for (const aw of wc.activeWorkspaces) {
      const n = wc.files.filter((f) => f.workspaceId === aw.workspaceId).length;
      const c = wc.files.filter((f) => f.workspaceId === aw.workspaceId && f.syncStatus === "conflict").length;
      let line = `• ${aw.workspaceNote}: ${String(n)} файл(ов)`;
      if (c > 0) {
        line += ` · ⚠ ${String(c)} конфликт(ов)`;
      }
      lines.push(line);
    }
    lines.push("");
    lines.push(`Провайдер: ${providerType ?? "—"}`);
    return lines.join("\n");
  }

  private buildMultiRootTooltip(
    loaded: FolderWorkspaceState[],
    providerLabelText: string,
    providerType: ProviderType | null,
    syncPaused: boolean,
  ): string {
    const lines: string[] = [
      `VSCodeSync · ${providerLabelText}`,
      `Корней в workspace: ${String(loaded.length)}`,
      "",
    ];
    if (syncPaused) {
      lines.push("⏸ Синхронизация на паузе — Resume / Toggle Pause.", "");
    }
    for (const { folder, wc } of loaded) {
      lines.push(`— ${folder.name} —`);
      if (wc.activeWorkspaces.length === 0) {
        lines.push("  (нет активных workspace)", "");
        continue;
      }
      for (const aw of wc.activeWorkspaces) {
        const n = wc.files.filter((f) => f.workspaceId === aw.workspaceId).length;
        const c = wc.files.filter((f) => f.workspaceId === aw.workspaceId && f.syncStatus === "conflict").length;
        let line = `  • ${aw.workspaceNote}: ${String(n)} файл(ов)`;
        if (c > 0) {
          line += ` · ⚠ ${String(c)} конфликт(ов)`;
        }
        lines.push(line);
      }
      lines.push("");
    }
    lines.push(`Провайдер: ${providerType ?? "—"}`);
    return lines.join("\n");
  }

  async showDashboard(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
      return;
    }
    const loaded = await this.loadAllFolderStates();
    const gc = await this.deps.globalConfig.load();
    const label = providerLabel(gc.activeProvider);

    const lines: string[] = [`Провайдер: ${label}`, ""];
    if (syncSessionPause.isPaused()) {
      lines.push("⏸ Синхронизация на паузе (Resume / Toggle Pause).");
      lines.push("");
    }
    for (const { folder, wc } of loaded) {
      if (loaded.length > 1) {
        lines.push(`▸ ${folder.name}`, "");
      }
      if (wc.activeWorkspaces.length === 0) {
        lines.push("  Нет активных workspace.", "");
        continue;
      }
      for (const aw of wc.activeWorkspaces) {
        const tracked = wc.files.filter((f) => f.workspaceId === aw.workspaceId);
        const c = tracked.filter((f) => f.syncStatus === "conflict").length;
        lines.push(`${aw.workspaceNote} (${aw.workspaceId})`);
        lines.push(`  файлов: ${String(tracked.length)} · конфликтов: ${String(c)}`);
      }
      lines.push("");
    }

    await vscode.window.showInformationMessage(lines.join("\n"), "Открыть настройки").then((choice) => {
      if (choice === "Открыть настройки") {
        void vscode.commands.executeCommand("workbench.action.openSettings", EXTENSION_SETTINGS_QUERY);
      }
    });
  }

  dispose(): void {
    if (this.syncingWatchdog !== undefined) {
      clearTimeout(this.syncingWatchdog);
      this.syncingWatchdog = undefined;
    }
    this.item.dispose();
    for (const d of this.workspaceJsonWatchDisposables) {
      d.dispose();
    }
    this.workspaceJsonWatchDisposables = [];
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
