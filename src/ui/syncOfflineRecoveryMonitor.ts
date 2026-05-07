import * as vscode from "vscode";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { isAutoSyncBlockedBySchedule } from "./syncScheduleGate.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { readPassiveOnlineHint } from "../utils/readNavigatorOnline.js";
import {
  allowImmediateOfflineFlushRetry,
  canAttemptOfflineFlushNow,
} from "../core/syncOfflineFlushBackoff.js";
import { flushOfflineQueue, type OfflineFlushDeps } from "./syncOfflineFlush.js";

export interface OfflineRecoveryMonitorDeps extends OfflineFlushDeps {
  offlineQueue: SyncOfflineQueueStore;
}

const TICK_MS = 10_000;

/**
 * Periodic flush of `queue.json` when passive online + gates allow, with active backoff between attempts.
 */
export function registerOfflineRecoveryMonitor(context: vscode.ExtensionContext, deps: OfflineRecoveryMonitorDeps): void {
  const tick = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted) {
      return;
    }
    try {
      const n = await deps.offlineQueue.totalPending();
      if (n === 0) {
        return;
      }
      if (syncSessionPause.isPaused()) {
        return;
      }
      if (syncAutoPause.isActive()) {
        return;
      }
      if (!readPassiveOnlineHint()) {
        return;
      }
      if (!canAttemptOfflineFlushNow()) {
        return;
      }
      if (isAutoSyncBlockedByRateLimit()) {
        return;
      }
      if (isAutoSyncBlockedBySchedule()) {
        return;
      }
      await flushOfflineQueue(deps.offlineQueue, deps);
    } catch {
      /* non-fatal */
    } finally {
      await deps.statusBar.refresh();
    }
  };

  const id = setInterval(() => {
    void tick();
  }, TICK_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearInterval(id);
    }),
  );

  const onOnline = (): void => {
    allowImmediateOfflineFlushRetry();
    void tick();
  };
  if (typeof (globalThis as Record<string, unknown>).addEventListener === "function") {
    (globalThis as unknown as EventTarget).addEventListener("online", onOnline);
    context.subscriptions.push(
      new vscode.Disposable(() => {
        (globalThis as unknown as EventTarget).removeEventListener("online", onOnline);
      }),
    );
  }

  void tick();
}
