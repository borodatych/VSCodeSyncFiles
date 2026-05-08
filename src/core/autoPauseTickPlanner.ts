/**
 * v3.M — pure decision helper that the `queuedProvider` hook will call on
 * every tick to decide whether to gate outbound calls due to a learned
 * quiet-hour schedule.
 *
 * Three inputs influence the decision:
 *   1) `LearnedSchedule` from `autoPauseLearner.ts` (or null = no schedule).
 *   2) `enabled` from the user setting (`vscodesync.autoPause.learnedSchedule.enabled`).
 *   3) An optional manual-resume timestamp: when the user explicitly says
 *      "resume now", we honour that for `manualResumeTtlMs` (default 1 hour)
 *      so background syncs don't silently re-pause within the same session.
 *
 * No `vscode` import. Side effects (toast, queue gate) live one layer up.
 */

import { isQuietHour, type LearnedSchedule } from "./autoPauseLearner.js";

export type AutoPauseTickDecision =
  | { paused: false; reason: "no_schedule" | "disabled" | "manual_resume_active" | "active_hour" }
  | { paused: true; reason: "quiet_hour"; resumesAtMs: number | null };

export interface AutoPauseTickInput {
  schedule: LearnedSchedule | null;
  enabled: boolean;
  nowMs: number;
  /** Most recent moment the user pressed "resume now" / equivalent. null when
   * the user never overrode the auto-pause this session. */
  manualResumedAtMs?: number | null;
  /** How long a manual override stays in effect. Default 1 hour. */
  manualResumeTtlMs?: number;
  /** Override the local timezone offset (minutes). Defaults to system tz. */
  timezoneOffsetMinutes?: number;
}

/** Default cool-off for an explicit manual resume. */
export const DEFAULT_MANUAL_RESUME_TTL_MS = 60 * 60_000;

export function decideAutoPauseAtTick(input: AutoPauseTickInput): AutoPauseTickDecision {
  if (!input.enabled) return { paused: false, reason: "disabled" };
  if (input.schedule === null) return { paused: false, reason: "no_schedule" };
  const ttl = input.manualResumeTtlMs ?? DEFAULT_MANUAL_RESUME_TTL_MS;
  const lastResume = input.manualResumedAtMs ?? null;
  if (lastResume !== null && input.nowMs - lastResume < ttl) {
    return { paused: false, reason: "manual_resume_active" };
  }
  if (!isQuietHour(input.schedule, input.nowMs, input.timezoneOffsetMinutes)) {
    return { paused: false, reason: "active_hour" };
  }
  const resumesAtMs = computeNextActiveHourMs(
    input.schedule,
    input.nowMs,
    input.timezoneOffsetMinutes,
  );
  return { paused: true, reason: "quiet_hour", resumesAtMs };
}

/** Walk the next 24 hours of `hourActive[]`; the first active slot is the
 * resume time. Returns `null` if every hour is quiet (degenerate schedule). */
function computeNextActiveHourMs(
  schedule: LearnedSchedule,
  nowMs: number,
  timezoneOffsetMinutes?: number,
): number | null {
  const offsetMs =
    (timezoneOffsetMinutes ?? -new Date().getTimezoneOffset()) * 60 * 1000;
  const local = new Date(nowMs + offsetMs);
  const localHour = local.getUTCHours();
  for (let step = 1; step <= 24; step += 1) {
    const candidateHour = (localHour + step) % 24;
    if (schedule.hourActive[candidateHour]) {
      // Snap to the top of that hour in local time.
      const start = new Date(nowMs + offsetMs);
      start.setUTCMinutes(0, 0, 0);
      const ms = start.getTime() + step * 60 * 60_000 - offsetMs;
      return ms;
    }
  }
  return null;
}
