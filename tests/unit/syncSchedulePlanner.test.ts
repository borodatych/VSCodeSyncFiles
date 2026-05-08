import { describe, expect, it } from "vitest";
import { isSyncDueAt, parseSyncSchedule } from "../../src/core/syncSchedulePlanner.js";

describe("parseSyncSchedule", () => {
  it("parses 'hourly'", () => {
    const r = parseSyncSchedule("hourly");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.schedule.kind).toBe("hourly");
  });

  it("parses 'daily 09:00,12:00,18:00' (sorted)", () => {
    const r = parseSyncSchedule("daily 18:00,09:00,12:00");
    expect(r.ok).toBe(true);
    if (r.ok && r.schedule.kind === "daily") {
      expect(r.schedule.minutesOfDay).toEqual([9 * 60, 12 * 60, 18 * 60]);
    }
  });

  it("parses 'weekly mon 09:00'", () => {
    const r = parseSyncSchedule("weekly mon 09:00");
    expect(r.ok).toBe(true);
    if (r.ok && r.schedule.kind === "weekly") {
      expect(r.schedule.weekday).toBe(1);
      expect(r.schedule.minutesOfDay).toEqual([9 * 60]);
    }
  });

  it("parses 'workhours 30m'", () => {
    const r = parseSyncSchedule("workhours 30m");
    expect(r.ok).toBe(true);
    if (r.ok && r.schedule.kind === "workhours") {
      expect(r.schedule.intervalMinutes).toBe(30);
      expect(r.schedule.startMinute).toBe(9 * 60);
      expect(r.schedule.endMinute).toBe(18 * 60);
      expect(r.schedule.weekdays).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("returns 'empty' on undefined / blank", () => {
    expect(parseSyncSchedule(undefined).ok).toBe(false);
    expect(parseSyncSchedule("").ok).toBe(false);
    expect(parseSyncSchedule("   ").ok).toBe(false);
  });

  it("returns 'syntax' on garbage / out-of-range", () => {
    for (const s of ["nope", "daily 25:00", "weekly xxx 09:00", "workhours 99999m", "daily 09:00,bad"]) {
      const r = parseSyncSchedule(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("syntax");
    }
  });
});

describe("isSyncDueAt", () => {
  it("hourly is due immediately when no last run", () => {
    const r = parseSyncSchedule("hourly");
    if (!r.ok) throw new Error("schedule did not parse");
    expect(isSyncDueAt(r.schedule, null, Date.now())).toBe(true);
  });

  it("hourly is not due 30 min after last run", () => {
    const r = parseSyncSchedule("hourly");
    if (!r.ok) throw new Error("schedule did not parse");
    const now = Date.now();
    expect(isSyncDueAt(r.schedule, now - 30 * 60_000, now)).toBe(false);
    expect(isSyncDueAt(r.schedule, now - 65 * 60_000, now)).toBe(true);
  });

  it("daily fires when slot has been crossed since last run", () => {
    const r = parseSyncSchedule("daily 09:00");
    if (!r.ok) throw new Error("schedule did not parse");
    // Anchor: 2026-06-15 (Monday).
    const morning = new Date(2026, 5, 15, 9, 5, 0).getTime();
    const earlier = new Date(2026, 5, 15, 7, 0, 0).getTime();
    // Last run was earlier today, current time is past 09:00 → due.
    expect(isSyncDueAt(r.schedule, earlier, morning)).toBe(true);
    // Last run was later than slot → not due again same day.
    const afterSlot = new Date(2026, 5, 15, 10, 0, 0).getTime();
    expect(isSyncDueAt(r.schedule, afterSlot, new Date(2026, 5, 15, 11, 0, 0).getTime())).toBe(
      false,
    );
  });

  it("workhours respects weekday + window + interval", () => {
    const r = parseSyncSchedule("workhours 30m");
    if (!r.ok) throw new Error("schedule did not parse");
    // Saturday — outside weekdays, never due.
    const sat = new Date(2026, 5, 13, 12, 0, 0).getTime();
    expect(isSyncDueAt(r.schedule, null, sat)).toBe(false);
    // Monday 14:00 — inside window, no last run → due.
    const mon14 = new Date(2026, 5, 15, 14, 0, 0).getTime();
    expect(isSyncDueAt(r.schedule, null, mon14)).toBe(true);
    // Monday 14:10 with last run 5 min ago → not due (interval 30m).
    expect(isSyncDueAt(r.schedule, mon14, new Date(2026, 5, 15, 14, 10, 0).getTime())).toBe(false);
    // Monday 14:35 with last run at 14:00 → due (≥30m).
    expect(isSyncDueAt(r.schedule, mon14, new Date(2026, 5, 15, 14, 35, 0).getTime())).toBe(true);
    // Monday 19:00 — outside window → not due.
    expect(isSyncDueAt(r.schedule, null, new Date(2026, 5, 15, 19, 0, 0).getTime())).toBe(false);
  });

  it("weekly only fires on the configured weekday", () => {
    const r = parseSyncSchedule("weekly mon 09:00");
    if (!r.ok) throw new Error("schedule did not parse");
    // Tue (weekday 2) → never due.
    const tue = new Date(2026, 5, 16, 9, 5, 0).getTime();
    expect(isSyncDueAt(r.schedule, null, tue)).toBe(false);
    // Mon 09:05, no last run today → due.
    const mon = new Date(2026, 5, 15, 9, 5, 0).getTime();
    expect(isSyncDueAt(r.schedule, null, mon)).toBe(true);
  });
});
