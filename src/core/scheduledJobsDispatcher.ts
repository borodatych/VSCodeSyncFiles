/**
 * Cross-cutting — unified dispatcher that aggregates the three engine-tick
 * planners shipped so far (`syncTickPlanner`, `backupVerifyScheduler`,
 * `autoPauseTickPlanner`) into a single ordered work queue plus next-probe
 * computation.
 *
 * Why: the engine's polling loop currently has to wake on the lowest of
 * three independent intervals, then call each planner separately. This
 * helper folds the calls into one entry point so the engine becomes
 * declarative: "what should I do at tick T?" → list of actions.
 *
 * No `vscode` import. The planners themselves are pure too, so this entire
 * pipeline is unit-testable end-to-end.
 */

import {
  planSyncTickAction,
  type SyncTickAction,
  type SyncTickInput,
} from "./syncTickPlanner.js";
import {
  planBackupVerifyTick,
  type BackupVerifyTickAction,
  type BackupVerifyTickInput,
} from "./backupVerifyScheduler.js";
import {
  decideAutoPauseAtTick,
  type AutoPauseTickDecision,
  type AutoPauseTickInput,
} from "./autoPauseTickPlanner.js";

export interface ScheduledJobsDispatcherInput {
  syncTick: SyncTickInput;
  backupVerifyTick: BackupVerifyTickInput;
  autoPauseTick: AutoPauseTickInput;
}

export type ScheduledJobAction =
  | { kind: "sync_now"; reason: SyncTickAction extends { reason: infer R } ? R : never }
  | { kind: "backup_verify_now"; reason: string }
  | { kind: "auto_pause"; reason: "quiet_hour"; resumesAtMs: number | null };

export interface ScheduledJobsDispatchResult {
  actions: ScheduledJobAction[];
  /** Next time the dispatcher wants to be re-invoked. min over all the
   * planners' next-probe / next-due timestamps. null when no future probe
   * is needed (everything terminal or disabled). */
  nextProbeMs: number | null;
  /** Detailed sub-results for callers that want to log telemetry. */
  details: {
    sync: SyncTickAction;
    backupVerify: BackupVerifyTickAction;
    autoPause: AutoPauseTickDecision;
  };
}

/** Run all three tick planners against the supplied inputs and return the
 * merged action queue plus the earliest "wake me again" timestamp. Order
 * of `actions[]` is intentionally stable: auto_pause first (it gates the
 * subsequent ops), backup_verify_now next, sync_now last (heaviest). */
export function dispatchScheduledJobs(
  input: ScheduledJobsDispatcherInput,
): ScheduledJobsDispatchResult {
  const sync = planSyncTickAction(input.syncTick);
  const backupVerify = planBackupVerifyTick(input.backupVerifyTick);
  const autoPause = decideAutoPauseAtTick(input.autoPauseTick);

  const actions: ScheduledJobAction[] = [];

  if (autoPause.paused) {
    actions.push({
      kind: "auto_pause",
      reason: "quiet_hour",
      resumesAtMs: autoPause.resumesAtMs,
    });
  }
  if (backupVerify.action === "verify_now") {
    actions.push({ kind: "backup_verify_now", reason: backupVerify.reason });
  }
  // Sync only fires when not paused — auto-pause + sync_now in the same
  // tick is contradictory.
  if (!autoPause.paused && sync.action === "sync_now") {
    actions.push({ kind: "sync_now", reason: sync.reason });
  }

  const nextProbeMs = pickEarliest([
    sync.action === "wait" ? sync.nextProbeMs : null,
    backupVerify.action === "wait" ? backupVerify.nextDueMs : null,
    autoPause.paused ? autoPause.resumesAtMs : null,
  ]);

  return { actions, nextProbeMs, details: { sync, backupVerify, autoPause } };
}

function pickEarliest(values: (number | null)[]): number | null {
  let min: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    if (min === null || v < min) min = v;
  }
  return min;
}
