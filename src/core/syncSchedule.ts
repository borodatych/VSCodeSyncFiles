/**
 * Sync schedule (wall-clock window + weekdays) for disabling automatic sync triggers.
 */

export interface SyncScheduleNormalized {
  enabled: boolean;
  /** e.g. "09:00-18:00" */
  activeHours: string;
  /** Short English weekday labels: Mon, Tue, … (also accepts Monday, etc.) */
  activeDays: string[];
  /** IANA zone id or "auto" */
  timezone: string;
}

const DEFAULT_HOURS = "09:00-18:00";
const DEFAULT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function normDayToken(d: string): string {
  const t = d.trim().slice(0, 3).toLowerCase();
  const map: Record<string, string> = {
    sun: "sun",
    mon: "mon",
    tue: "tue",
    wed: "wed",
    thu: "thu",
    fri: "fri",
    sat: "sat",
  };
  return map[t] ?? t;
}

/** Parse activeHours like "09:00-18:00" → minutes from midnight [start,end). Supports overnight spans. */
export function parseActiveHours(activeHours: string): { startMin: number; endMin: number } | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(activeHours.trim());
  if (!m) {
    return null;
  }
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  if (![sh, sm, eh, em].every((n) => Number.isFinite(n))) {
    return null;
  }
  if (sm < 0 || sm > 59 || em < 0 || em > 59 || sh < 0 || sh > 23 || eh < 0 || eh > 23) {
    return null;
  }
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  return { startMin, endMin };
}

export function daysListMatches(shortWeekdayFromIntl: string, configuredDays: string[]): boolean {
  if (configuredDays.length === 0) {
    return true;
  }
  const cur = normDayToken(shortWeekdayFromIntl);
  const allowed = new Set(configuredDays.map(normDayToken));
  return allowed.has(cur);
}

export interface ZonedWallClock {
  weekdayShort: string;
  hour: number;
  minute: number;
}

export function getWallClockInTimeZone(date: Date, timeZone: string): ZonedWallClock | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(date);
    let weekdayShort = "";
    let hour = -1;
    let minute = -1;
    for (const p of parts) {
      if (p.type === "weekday") {
        weekdayShort = p.value;
      } else if (p.type === "hour") {
        hour = Number.parseInt(p.value, 10);
      } else if (p.type === "minute") {
        minute = Number.parseInt(p.value, 10);
      }
    }
    if (!weekdayShort || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return { weekdayShort, hour, minute };
  } catch {
    return null;
  }
}

export function resolveEffectiveTimeZone(schedule: SyncScheduleNormalized): string {
  const tz = schedule.timezone.trim();
  if (!tz || tz.toLowerCase() === "auto") {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }
  return tz;
}

/** Minutes from midnight for `date` in `timeZone`. */
export function minuteOfDayInZone(date: Date, timeZone: string): number | null {
  const wc = getWallClockInTimeZone(date, timeZone);
  if (!wc) {
    return null;
  }
  return wc.hour * 60 + wc.minute;
}

export function isMinuteWithinWindow(m: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) {
    return false;
  }
  if (startMin < endMin) {
    return m >= startMin && m < endMin;
  }
  /* Overnight e.g. 22:00–06:00 */
  return m >= startMin || m < endMin;
}

export function normalizeSyncSchedule(raw: unknown): SyncScheduleNormalized {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const enabled = Boolean(o.enabled);
  const activeHours = typeof o.activeHours === "string" && o.activeHours.trim().length > 0 ? o.activeHours.trim() : DEFAULT_HOURS;
  let activeDays: string[] = DEFAULT_DAYS;
  if (Array.isArray(o.activeDays) && o.activeDays.length > 0) {
    activeDays = o.activeDays.filter((x): x is string => typeof x === "string");
  }
  const timezone = typeof o.timezone === "string" && o.timezone.trim().length > 0 ? o.timezone.trim() : "auto";
  return {
    enabled,
    activeHours,
    activeDays,
    timezone,
  };
}

export function isWithinSyncSchedule(schedule: SyncScheduleNormalized, date: Date = new Date()): boolean {
  if (!schedule.enabled) {
    return true;
  }
  const parsed = parseActiveHours(schedule.activeHours);
  if (!parsed) {
    return true;
  }
  const tz = resolveEffectiveTimeZone(schedule);
  const wc = getWallClockInTimeZone(date, tz);
  if (!wc) {
    return true;
  }
  if (!daysListMatches(wc.weekdayShort, schedule.activeDays)) {
    return false;
  }
  const mod = minuteOfDayInZone(date, tz);
  if (mod === null) {
    return true;
  }
  return isMinuteWithinWindow(mod, parsed.startMin, parsed.endMin);
}

/** Short hint when automatic sync is paused by schedule (Russian UI string). */
export function describeScheduleActiveHint(schedule: SyncScheduleNormalized): string {
  const parsed = parseActiveHours(schedule.activeHours);
  if (!parsed) {
    return "активно по расписанию";
  }
  const sh = Math.floor(parsed.startMin / 60);
  const sm = parsed.startMin % 60;
  const eh = Math.floor(parsed.endMin / 60);
  const em = parsed.endMin % 60;
  const fmt = (h: number, mi: number) => `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  return `${fmt(sh, sm)}–${fmt(eh, em)}`;
}
