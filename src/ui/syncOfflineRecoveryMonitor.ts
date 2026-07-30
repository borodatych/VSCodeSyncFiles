import * as vscode from "vscode";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { readPassiveOnlineHint } from "../utils/readNavigatorOnline.js";
import { allowImmediateOfflineFlushRetry } from "../core/syncOfflineFlushBackoff.js";
import { flushOfflineQueue, type OfflineFlushDeps } from "./syncOfflineFlush.js";

export interface OfflineRecoveryMonitorDeps extends OfflineFlushDeps {
  offlineQueue: SyncOfflineQueueStore;
}

const TICK_MS = 10_000;

/**
 * Watches the persisted offline queue and *offers* to run it (B2).
 *
 * Until stage 3 this monitor executed the queue itself every 10 seconds,
 * passing all three `bypass*` flags — a timer moving files with every brake
 * released, on items that were enqueued by earlier automatic failures. Now the
 * only thing that happens automatically is a notification; the flush runs with
 * `trigger: "user"` from its buttons.
 *
 * The notification re-arms only when the pending count changes, so a queue the
 * user chose to leave alone does not nag every tick.
 */
export function registerOfflineRecoveryMonitor(context: vscode.ExtensionContext, deps: OfflineRecoveryMonitorDeps): void {
  let lastOfferedCount = 0;
  let offerInFlight = false;

  const offer = async (n: number): Promise<void> => {
    offerInFlight = true;
    try {
      const picked = await vscode.window.showInformationMessage(
        `VSCodeSync: сеть доступна, в оффлайн-очереди ${String(n)} отложенных операций.`,
        "Выполнить",
        "Очистить",
      );
      if (picked === "Выполнить") {
        // The click is the consent — the flush engines run as "user".
        await flushOfflineQueue(deps.offlineQueue, { ...deps, trigger: "user" });
        lastOfferedCount = 0;
      } else if (picked === "Очистить") {
        const dropped = await deps.offlineQueue.drainSnapshot();
        void vscode.window.showInformationMessage(
          `VSCodeSync: оффлайн-очередь очищена (${String(dropped.length)} операций). Файлы на диске не тронуты.`,
        );
        lastOfferedCount = 0;
      }
    } finally {
      offerInFlight = false;
      await deps.statusBar.refresh();
    }
  };

  const tick = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted || offerInFlight) {
      return;
    }
    try {
      const n = await deps.offlineQueue.totalPending();
      if (n === 0) {
        lastOfferedCount = 0;
        return;
      }
      if (syncSessionPause.isPaused() || syncAutoPause.isActive()) {
        return;
      }
      if (!readPassiveOnlineHint()) {
        return;
      }
      if (isAutoSyncBlockedByRateLimit()) {
        return;
      }
      if (n === lastOfferedCount) {
        return;
      }
      lastOfferedCount = n;
      void offer(n);
    } catch {
      /* non-fatal */
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
