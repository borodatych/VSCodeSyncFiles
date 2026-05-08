/**
 * v3.F — pure tick-decision wrapper around `isSyncDueAt` so the engine
 * polling loop has a single uniform interface across schedulers.
 *
 * Mirrors the shape of `planBackupVerifyTick` (`backupVerifyScheduler.ts`)
 * intentionally — the engine drains both through the same dispatcher.
 *
 * No `vscode` import. Caller persists `lastRunMs` between sessions in
 * globalState.
 */

import { isSyncDueAt, type SyncSchedule } from "./syncSchedulePlanner.js";

export type SyncTickAction =
  | { action: "sync_now"; reason: "first_run" | "schedule_due" }
  | {
      action: "wait";
      reason: "disabled" | "no_schedule" | "schedule_pending";
      nextProbeMs: number | null;
    };

export interface SyncTickInput {
  /** Whether the user setting is on. */
  enabled: boolean;
  /** Parsed schedule (or null when the setting is empty / unparseable). */
  schedule: SyncSchedule | null;
  /** ms timestamp of last completed sync, null when never run. */
  lastRunMs: number | null;
  /** ms — caller-supplied "now". */
  nowMs: number;
  /** Optional polling interval ms — if the schedule is not due now, suggest
   * the next probe time. Default = 5 min. */
  defaultProbeMs?: number;
}

const DEFAULT_PROBE_MS = 5 * 60_000;

export function planSyncTickAction(input: SyncTickInput): SyncTickAction {
  if (!input.enabled) {
    return { action: "wait", reason: "disabled", nextProbeMs: null };
  }
  if (input.schedule === null) {
    return { action: "wait", reason: "no_schedule", nextProbeMs: null };
  }
  if (input.lastRunMs === null) {
    return { action: "sync_now", reason: "first_run" };
  }
  if (isSyncDueAt(input.schedule, input.lastRunMs, input.nowMs)) {
    return { action: "sync_now", reason: "schedule_due" };
  }
  const probe = input.defaultProbeMs ?? DEFAULT_PROBE_MS;
  return {
    action: "wait",
    reason: "schedule_pending",
    nextProbeMs: input.nowMs + probe,
  };
}
