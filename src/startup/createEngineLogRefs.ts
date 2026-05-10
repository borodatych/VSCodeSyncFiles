/**
 * v2.6.7 — engine activity / stats / compression log refs, extracted from
 * `extension.ts`. The engine factory's `setRefs(...)` accepts three async
 * sinks; this factory packs them into one dependency-injected bundle so
 * the activate() function only deals with one constant.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { appendActivityEvent } from "../core/activityLog.js";
import { recordCompressionSaving, recordTransferBytes } from "../core/syncStatsStore.js";
import { recordDigestPush, recordDigestPull, recordDigestConflict } from "../ui/notificationService.js";
import type { ActivityAlertMonitor } from "../ui/activityAlertMonitor.js";
import type { createEngineFactory } from "./_engineFactory.js";

const CFG_SECTION = "vscodesync";

type SetRefsArg = Parameters<ReturnType<typeof createEngineFactory>["setRefs"]>[0];

export interface EngineLogRefsDeps {
  globalConfig: GlobalConfigManager;
  activityAlertMonitor: ActivityAlertMonitor;
  /** Lazily resolved — the timeline provider is created later than the
   *  engine factory, so the caller passes `() => timelineRef?.()` and the
   *  log path is a no-op until that ref is wired. */
  fireTimelineChange: () => void;
}

export interface EngineLogRefs {
  logSyncActivity: NonNullable<SetRefsArg["logSyncActivity"]>;
  logSyncStatsTransfer: NonNullable<SetRefsArg["logSyncStatsTransfer"]>;
  logSyncCompression: NonNullable<SetRefsArg["logSyncCompression"]>;
}

export function createEngineLogRefs(deps: EngineLogRefsDeps): EngineLogRefs {
  const { globalConfig, activityAlertMonitor, fireTimelineChange } = deps;
  return {
    logSyncActivity: (ev) => {
      const retention = vscode.workspace.getConfiguration(CFG_SECTION).get<number>("activityRetentionDays", 90);
      void appendActivityEvent(globalConfig.getStorageDir(), ev, retention);
      fireTimelineChange();
      activityAlertMonitor.notify(ev);
      if (ev.kind === "push") recordDigestPush(1, ev.machineName);
      else if (ev.kind === "pull") recordDigestPull(1, ev.machineName);
      else if (ev.kind === "conflict") recordDigestConflict(ev.relPath);
      void (async () => {
        try {
          const { feedActivity } = await import("../ui/syncReplayRecorderState.js");
          feedActivity(ev);
        } catch { /* recorder is best-effort; silent */ }
      })();
    },
    logSyncStatsTransfer: (ev) => {
      void recordTransferBytes(globalConfig.getStorageDir(), ev);
    },
    logSyncCompression: (saved) => {
      void recordCompressionSaving(globalConfig.getStorageDir(), saved);
    },
  };
}
