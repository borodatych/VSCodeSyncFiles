/**
 * v3.F — pure parser for the `vscodesync.syncSchedule` setting.
 *
 * Supported syntax (extended from existing snapshotSchedule):
 *
 *   "hourly"
 *   "daily 09:00"
 *   "daily 09:00,12:00,18:00"
 *   "workhours 30m"        — every 30 min during 09:00-18:00 Mon-Fri
 *   "weekly mon 09:00"
 *
 * The parser turns a string into a `SyncSchedule` object; `isDueAt(schedule,
 * lastRunMs, nowMs)` answers whether the engine should kick a sync now.
 *
 * No `vscode` import. Time math uses local-time hour-of-day from the supplied
 * `now`; caller is responsible for timezone discipline.
 */

export type SyncSchedule =
  | { kind: "hourly" }
  | { kind: "daily"; minutesOfDay: number[] }
  | { kind: "weekly"; weekday: number; minutesOfDay: number[] }
  | { kind: "workhours"; intervalMinutes: number; startMinute: number; endMinute: number; weekdays: number[] };

export type ParseSyncScheduleResult =
  | { ok: true; schedule: SyncSchedule }
  | { ok: false; reason: "empty" | "syntax" };

const WEEKDAY_NAMES: Partial<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(text: string): number | null {
  const m = HHMM_RE.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h * 60 + min;
}

export function parseSyncSchedule(raw: string | undefined | null): ParseSyncScheduleResult {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  const text = raw.trim().toLowerCase();
  if (text === "hourly") return { ok: true, schedule: { kind: "hourly" } };

  const dailyMatch = /^daily\s+(.+)$/.exec(text);
  if (dailyMatch) {
    const slots = dailyMatch[1].split(",").map((s) => s.trim());
    const minutes: number[] = [];
    for (const s of slots) {
      const v = parseHHMM(s);
      if (v === null) return { ok: false, reason: "syntax" };
      minutes.push(v);
    }
    minutes.sort((a, b) => a - b);
    return { ok: true, schedule: { kind: "daily", minutesOfDay: minutes } };
  }

  const weeklyMatch = /^weekly\s+(\w+)\s+(\S+)$/.exec(text);
  if (weeklyMatch) {
    const weekday = WEEKDAY_NAMES[weeklyMatch[1].slice(0, 3)];
    if (weekday === undefined) return { ok: false, reason: "syntax" };
    const minute = parseHHMM(weeklyMatch[2]);
    if (minute === null) return { ok: false, reason: "syntax" };
    return { ok: true, schedule: { kind: "weekly", weekday, minutesOfDay: [minute] } };
  }

  const workhoursMatch = /^workhours\s+(\d+)m$/.exec(text);
  if (workhoursMatch) {
    const intervalMinutes = Number(workhoursMatch[1]);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 720) {
      return { ok: false, reason: "syntax" };
    }
    return {
      ok: true,
      schedule: {
        kind: "workhours",
        intervalMinutes,
        startMinute: 9 * 60,
        endMinute: 18 * 60,
        weekdays: [1, 2, 3, 4, 5],
      },
    };
  }

  return { ok: false, reason: "syntax" };
}

/** Decide whether `schedule` says "run now" given the last successful run
 * timestamp and the current local time. Local time is read from `now` via
 * `Date(now)` — caller picks the timezone semantics. */
export function isSyncDueAt(
  schedule: SyncSchedule,
  lastRunMs: number | null,
  nowMs: number,
): boolean {
  const d = new Date(nowMs);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();
  const weekday = d.getDay();

  switch (schedule.kind) {
    case "hourly": {
      if (lastRunMs === null) return true;
      return nowMs - lastRunMs >= 60 * 60_000;
    }
    case "daily": {
      // Due if we have crossed any minutesOfDay slot between lastRun and now.
      return crossedSlot(schedule.minutesOfDay, lastRunMs, nowMs);
    }
    case "weekly": {
      if (weekday !== schedule.weekday) return false;
      return crossedSlot(schedule.minutesOfDay, lastRunMs, nowMs);
    }
    case "workhours": {
      if (!schedule.weekdays.includes(weekday)) return false;
      if (minuteOfDay < schedule.startMinute || minuteOfDay >= schedule.endMinute) return false;
      if (lastRunMs === null) return true;
      return nowMs - lastRunMs >= schedule.intervalMinutes * 60_000;
    }
  }
}

function crossedSlot(slotMinutes: number[], lastRunMs: number | null, nowMs: number): boolean {
  const d = new Date(nowMs);
  const todayStartMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const lastRun = lastRunMs ?? 0;
  for (const slot of slotMinutes) {
    const slotMs = todayStartMs + slot * 60_000;
    if (slotMs <= nowMs && slotMs > lastRun) return true;
  }
  return false;
}
