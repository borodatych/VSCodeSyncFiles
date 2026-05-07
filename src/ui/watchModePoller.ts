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
        const next = Math.min(currentMs * 2, maxMs());
        if (next !== currentMs) {
          applyInterval(next);
        }
      }
    }
  };

  schedule();

  context.subscriptions.push(
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