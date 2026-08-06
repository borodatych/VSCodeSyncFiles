import * as vscode from "vscode";
import type { QuietFullSyncAllFoldersDeps } from "./quietFullSyncAllFolders.js";
import { runQuietFullSyncAllFolders } from "./quietFullSyncAllFolders.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import {
  isWebhookSubscriptionActive,
  isWebhookWatchPollingSuppressed,
} from "./webhookChannelCoordinator.js";
import { isAutoCheckEnabled, parseAutoSyncMode } from "../core/autoSyncMode.js";
import { verboseLog, warnLog } from "../utils/log.js";

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
  /** True while a tick is in flight — see the overlap guard in `applyInterval`. */
  let tickRunning = false;
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
      // Guard against overlap: a tick slower than the interval used to start a
      // second one on top of the first, and each of those held the status-bar
      // spinner and the request queue.
      if (tickRunning) {
        verboseLog("watch", "предыдущий тик ещё идёт — пропускаю");
        return;
      }
      tickRunning = true;
      void tick().finally(() => {
        tickRunning = false;
      });
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
    // Watch Mode is a scheduled detector pass: `off` → silent, `check-only`
    // → statuses only. The quiet-hours upgrade to `full` is gone with the
    // mode (stage 3.4, B9) — "no one is looking" is not consent.
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

    let changed = false;
    try {
      changed = await runQuietFullSyncAllFolders(deps);
    } catch (e) {
      // Fail-safe: never let a single tick failure break the polling loop.
      // The interval is cleared/reset by `applyInterval`; a thrown error
      // here would propagate out of setInterval's callback and surface as
      // an unhandled rejection without restarting the timer cleanly.
      warnLog(
        "watchModePoller",
        `tick failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

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