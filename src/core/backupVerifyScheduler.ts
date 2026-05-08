/**
 * v3.I — pure scheduler decision for the cross-cloud backup verification
 * background job. The engine wakes every N minutes; this helper answers
 * "should we run a verify now, or wait until X?" given the last run's
 * severity verdict.
 *
 * The point of separating this from `backupVerifyPlanner` (which compares
 * primary vs secondary manifests) is that scheduling is independent of the
 * comparison logic — the engine can poll the scheduler without ever fetching
 * either provider's manifest.
 *
 * No `vscode` import. Caller persists `lastRunMs` + `lastSeverity` between
 * sessions in globalState.
 */

import type { BackupVerifySeverity } from "./backupVerifyPlanner.js";

export type BackupVerifyTickAction =
  | { action: "verify_now"; reason: "first_run" | "interval_due" | "broken_retry" }
  | { action: "wait"; reason: "interval_pending" | "disabled"; nextDueMs: number | null };

export interface BackupVerifyTickInput {
  /** Whether the user setting is on. */
  enabled: boolean;
  /** ms timestamp of last completed verify, null when never run. */
  lastRunMs: number | null;
  /** Severity of the last completed verify; null when never run or not stored. */
  lastSeverity: BackupVerifySeverity | null;
  /** ms — caller-supplied "now". */
  nowMs: number;
  /** Default cadence (ms). e.g. 24h for daily. */
  intervalMs: number;
  /** Optional: when the last verify came back "broken", retry sooner.
   * Default: intervalMs / 4 (i.e. 6h if normal cadence is 24h). */
  brokenBackoffMs?: number;
}

export const DEFAULT_VERIFY_INTERVAL_MS = 24 * 60 * 60_000;

export function planBackupVerifyTick(input: BackupVerifyTickInput): BackupVerifyTickAction {
  if (!input.enabled) {
    return { action: "wait", reason: "disabled", nextDueMs: null };
  }
  if (input.lastRunMs === null) {
    return { action: "verify_now", reason: "first_run" };
  }
  const interval = chooseInterval(input);
  const dueAt = input.lastRunMs + interval;
  if (input.nowMs >= dueAt) {
    if (input.lastSeverity === "broken") {
      return { action: "verify_now", reason: "broken_retry" };
    }
    return { action: "verify_now", reason: "interval_due" };
  }
  return { action: "wait", reason: "interval_pending", nextDueMs: dueAt };
}

/** When the last verify was "broken", we want to confirm sooner that the
 * next backup cycle fixed the divergence — so we shorten the cadence. */
function chooseInterval(input: BackupVerifyTickInput): number {
  if (input.lastSeverity === "broken") {
    return input.brokenBackoffMs ?? Math.floor(input.intervalMs / 4);
  }
  return input.intervalMs;
}
