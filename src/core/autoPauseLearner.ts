/**
 * v3.M — pure clusterer for "active hours" / "quiet hours" inference from
 * activity-log timestamps. Aggregates by hour-of-day across the supplied
 * timestamps, classifies each hour as active / quiet via a configurable
 * fraction-of-mean threshold, and returns a 24-element pattern.
 *
 * Caller (UI service) reads `activity.json`, extracts timestamps from the
 * last N days, and feeds them in. Output drives the optional auto-pause
 * during quiet hours.
 */

export const DEFAULT_QUIET_HOUR_RATIO = 0.25;

export interface LearnedSchedule {
  /** 24-element array — true = active hour, false = quiet hour (auto-pause). */
  hourActive: boolean[];
  /** Per-hour event counts (length 24). */
  countsByHour: number[];
  /** Mean events per hour over the input window (≥ 0). */
  meanPerHour: number;
  /** Hours with count below this fraction of mean are classified as quiet. */
  quietHourRatio: number;
}

/** Empty schedule returned when input is too small to be meaningful. */
export const EMPTY_SCHEDULE: LearnedSchedule = {
  hourActive: new Array(24).fill(true) as boolean[],
  countsByHour: new Array(24).fill(0) as number[],
  meanPerHour: 0,
  quietHourRatio: DEFAULT_QUIET_HOUR_RATIO,
};

export interface LearnAutoPauseScheduleOptions {
  /** Below mean × this ratio → hour is "quiet". Default 0.25. */
  quietHourRatio?: number;
  /** Need at least this many events before learning (default 100). Below it →
   * EMPTY_SCHEDULE so the user is not auto-paused on a weekend's worth of
   * data. */
  minEvents?: number;
  /** Override the local timezone offset (minutes). Default = system. */
  timezoneOffsetMinutes?: number;
}

export function learnAutoPauseSchedule(
  timestampsMs: number[],
  options: LearnAutoPauseScheduleOptions = {},
): LearnedSchedule {
  const minEvents = options.minEvents ?? 100;
  if (timestampsMs.length < minEvents) {
    return { ...EMPTY_SCHEDULE, countsByHour: new Array(24).fill(0) as number[] };
  }
  const offsetMs =
    (options.timezoneOffsetMinutes ?? -new Date().getTimezoneOffset()) * 60 * 1000;
  const counts = new Array<number>(24).fill(0);
  for (const ts of timestampsMs) {
    const d = new Date(ts + offsetMs);
    const hour = d.getUTCHours();
    counts[hour] += 1;
  }
  const total = counts.reduce((s, c) => s + c, 0);
  const mean = total / 24;
  const ratio = options.quietHourRatio ?? DEFAULT_QUIET_HOUR_RATIO;
  const threshold = mean * ratio;
  const hourActive = counts.map((c) => c >= threshold);
  return {
    hourActive,
    countsByHour: counts,
    meanPerHour: mean,
    quietHourRatio: ratio,
  };
}

/** Returns true if the supplied timestamp falls in a quiet hour by the
 * learned schedule. */
export function isQuietHour(schedule: LearnedSchedule, nowMs: number, timezoneOffsetMinutes?: number): boolean {
  const offsetMs = (timezoneOffsetMinutes ?? -new Date().getTimezoneOffset()) * 60 * 1000;
  const d = new Date(nowMs + offsetMs);
  return !schedule.hourActive[d.getUTCHours()];
}
