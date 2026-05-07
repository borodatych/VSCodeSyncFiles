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
 * Detects transition from "outside syncSchedule window" → inside and flushes deferred queue.
 */
export function registerSyncScheduleTransition(context: vscode.ExtensionContext, opts: RegisterSyncScheduleTransitionOpts): void {
  let wasBlocked = isAutoSyncBlockedBySchedule();

  const poll = (): void => {
    const blocked = isAutoSyncBlockedBySchedule();
    if (wasBlocked && !blocked) {
      void flushScheduleDeferredQueue(opts.store, opts.flushDeps).catch(() => {
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
