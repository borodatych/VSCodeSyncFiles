import * as vscode from "vscode";
import type { QuietFullSyncAllFoldersDeps } from "./quietFullSyncAllFolders.js";
import { runQuietFullSyncAllFolders } from "./quietFullSyncAllFolders.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { isAutoSyncBlockedBySchedule } from "./syncScheduleGate.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import {
  isWebhookSubscriptionActive,
  isWebhookWatchPollingSuppressed,
} from "./webhookChannelCoordinator.js";
import { isAutoCheckEnabled, parseAutoSyncMode } from "../core/autoSyncMode.js";

const CFG = "vscodesync";

/** Current Watch Mode polling interval in ms — updated by `applyInterval`. Used by status bar. */
let _currentWatchIntervalMs = 0;

export function getCurrentWatchIntervalMs(): number {
  return _currentWatchIntervalMs;
}

/**
 * Interval-based full sync when `watchMode` is enabled.
 * Implements adaptive interval: after 5 consecutive idle cycles, doubles interval up to max.
 * Resets to base on any detected change.
 */
export function registerWatchModePoller(context: vscode.ExtensionContext, deps: QuietFullSyncAllFoldersDeps): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let idleCycles = 0;
  let currentMs = 0;
  let prevWebhookPollingSuppressed: boolean | undefined;

  // EWMA of inter-save intervals — informs how aggressively to scale up
  // the polling interval during idle. Tracks document.save events on tracked
  // files; pure save-rate, no provider hits.
  const EWMA_ALPHA = 0.3;
  let lastSaveAtMs: number | undefined;
  let ewmaSaveIntervalMs: number | undefined;

  const baseMs = (): number => {
    const sec = vscode.workspace.getConfiguration(CFG).get<number>("watchIntervalSeconds", 30);
    return Math.max(5, sec) * 1000;
  };

  const maxMs = (): number => {
    const sec = vscode.workspace.getConfiguration(CFG).get<number>("watchMaxIntervalSeconds", 300);
    return Math.max(baseMs(), sec) * 1000;
  };

  const adaptive = (): boolean =>
    vscode.workspace.getConfiguration(CFG).get<boolean>("watchAdaptive", true);

  const applyInterval = (ms: number): void => {
    if (timer !== undefined) {
      clearInterval(timer);
    }
    currentMs = ms;
    _currentWatchIntervalMs = ms;
    timer = setInterval(() => {
      void tick();
    }, ms);
  };

  const schedule = (): void => {
    idleCycles = 0;
    applyInterval(baseMs());
  };

  const tick = async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration(CFG);
    if (!cfg.get<boolean>("watchMode", false)) {
      return;
    }
    // v0.7 — Watch Mode also obeys autoSyncMode. `off` → silent; `check-only`
    // → quietFullSync runs in check-only branch (statuses only).
    const autoMode = parseAutoSyncMode(cfg.get<string>("autoSyncMode", "check-only"));
    if (!isAutoCheckEnabled(autoMode)) {
      return;
    }
    if (syncSessionPause.isPaused()) {
      return;
    }
    if (syncAutoPause.isActive()) {
      return;
    }
    if (isAutoSyncBlockedBySchedule()) {
      return;
    }
    if (isAutoSyncBlockedByRateLimit()) {
      return;
    }
    const webhooksOn = cfg.get<boolean>("webhooks.enabled", false);
    const suppressPolling = webhooksOn && isWebhookWatchPollingSuppressed();
    if (webhooksOn && prevWebhookPollingSuppressed === true && !suppressPolling && isWebhookSubscriptionActive()) {
      void vscode.window.showWarningMessage(
        "VSCodeSync Watch Mode: push-уведомления не приходят дольше порога — снова включён interval polling (см. vscodesync.webhooks.fallbackAfterMinutes, панель «Webhooks»).",
      );
    }
    prevWebhookPollingSuppressed = suppressPolling;
    if (webhooksOn && suppressPolling) {
      return;
    }

    const changed = await runQuietFullSyncAllFolders(deps);

    if (!adaptive()) {
      return;
    }
    if (changed) {
      // Changes detected — reset to base interval
      if (currentMs !== baseMs()) {
        idleCycles = 0;
        applyInterval(baseMs());
      } else {
        idleCycles = 0;
      }
    } else {
      idleCycles += 1;
      if (idleCycles >= 5) {
        idleCycles = 0;
        // EWMA-aware scaling: if the user hasn't been saving anywhere near
        // the current poll cadence, scale up faster (4×) to save quota.
        const ewma = ewmaSaveIntervalMs;
        const factor = ewma !== undefined && ewma > currentMs * 3 ? 4 : 2;
        const next = Math.min(currentMs * factor, maxMs());
        if (next !== currentMs) {
          applyInterval(next);
        }
      }
    }
  };

  schedule();

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      const now = Date.now();
      if (lastSaveAtMs !== undefined) {
        const delta = now - lastSaveAtMs;
        if (delta > 0) {
          ewmaSaveIntervalMs =
            ewmaSaveIntervalMs === undefined
              ? delta
              : EWMA_ALPHA * delta + (1 - EWMA_ALPHA) * ewmaSaveIntervalMs;
        }
      }
      lastSaveAtMs = now;
      // Activity heuristic: a save while we're on a back-off interval is a
      // strong hint that the user is back — drop instantly to base.
      if (currentMs > baseMs()) {
        applyInterval(baseMs());
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CFG}.watchMode`) ||
        e.affectsConfiguration(`${CFG}.watchIntervalSeconds`) ||
        e.affectsConfiguration(`${CFG}.watchMaxIntervalSeconds`) ||
        e.affectsConfiguration(`${CFG}.watchAdaptive`) ||
        e.affectsConfiguration(`${CFG}.webhooks.enabled`) ||
        e.affectsConfiguration(`${CFG}.webhooks.url`) ||
        e.affectsConfiguration(`${CFG}.webhooks.localPort`) ||
        e.affectsConfiguration(`${CFG}.webhooks.fallbackAfterMinutes`)
      ) {
        schedule();
      }
    }),
    new vscode.Disposable(() => {
      if (timer !== undefined) {
        clearInterval(timer);
      }
    }),
  );

  void tick();
}