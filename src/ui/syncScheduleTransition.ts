import * as vscode from "vscode";
import { isAutoSyncBlockedBySchedule } from "./syncScheduleGate.js";
import type { SyncScheduleDeferredStore } from "../core/syncScheduleDeferredStore.js";
import type { ScheduleDeferredFlushDeps } from "./syncScheduleDeferredFlush.js";
import { flushScheduleDeferredQueue } from "./syncScheduleDeferredFlush.js";

export interface RegisterSyncScheduleTransitionOpts {
  store: SyncScheduleDeferredStore;
  flushDeps: ScheduleDeferredFlushDeps;
  statusBar: { refresh: () => Promise<void> };
}

/**
 * Detects the "outside syncSchedule window" → inside transition and *offers*
 * the deferred queue (B3). The window opening used to be the trigger for a
 * silent flush — scheduling delayed the sync instead of requiring consent for
 * it. Now the transition produces one notification; the flush itself runs with
 * `trigger: "user"` from the button.
 */
export function registerSyncScheduleTransition(context: vscode.ExtensionContext, opts: RegisterSyncScheduleTransitionOpts): void {
  let wasBlocked = isAutoSyncBlockedBySchedule();

  const offer = async (): Promise<void> => {
    const n = await opts.store.totalPending();
    if (n === 0) {
      return;
    }
    const picked = await vscode.window.showInformationMessage(
      `VSCodeSync: окно расписания открылось, отложенных операций: ${String(n)}.`,
      "Выполнить",
      "Очистить",
    );
    if (picked === "Выполнить") {
      await flushScheduleDeferredQueue(opts.store, { ...opts.flushDeps, trigger: "user" });
    } else if (picked === "Очистить") {
      const dropped = await opts.store.drainSnapshot();
      void vscode.window.showInformationMessage(
        `VSCodeSync: очередь расписания очищена (${String(dropped.length)} операций). Файлы на диске не тронуты.`,
      );
    }
  };

  const poll = (): void => {
    const blocked = isAutoSyncBlockedBySchedule();
    if (wasBlocked && !blocked) {
      void offer().catch(() => {
        /* logged by VS Code notification paths */
      });
    }
    wasBlocked = blocked;
    void opts.statusBar.refresh();
  };

  const id = setInterval(poll, 15000);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearInterval(id);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.syncSchedule")) {
        wasBlocked = isAutoSyncBlockedBySchedule();
        void opts.statusBar.refresh();
      }
    }),
  );

  poll();
}
