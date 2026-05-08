import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANUAL_RESUME_TTL_MS,
  decideAutoPauseAtTick,
} from "../../src/core/autoPauseTickPlanner.js";
import {
  EMPTY_SCHEDULE,
  type LearnedSchedule,
} from "../../src/core/autoPauseLearner.js";

function scheduleWithQuietHours(quietHours: number[]): LearnedSchedule {
  const hourActive = new Array<boolean>(24).fill(true);
  for (const h of quietHours) hourActive[h] = false;
  return {
    hourActive,
    countsByHour: new Array(24).fill(0) as number[],
    meanPerHour: 100,
    quietHourRatio: 0.25,
  };
}

/** Build a UTC-anchored timestamp for a given `localHour` so the test does
 * not depend on the runner's timezone. */
function tsAtUtcHour(localHour: number): number {
  const d = new Date(Date.UTC(2026, 0, 1, localHour, 0, 0));
  return d.getTime();
}

describe("decideAutoPauseAtTick — guards", () => {
  it("never pauses when enabled=false", () => {
    const r = decideAutoPauseAtTick({
      schedule: scheduleWithQuietHours([2, 3, 4]),
      enabled: false,
      nowMs: tsAtUtcHour(3),
      timezoneOffsetMinutes: 0,
    });
    expect(r).toEqual({ paused: false, reason: "disabled" });
  });

  it("never pauses when no schedule has been learned yet", () => {
    const r = decideAutoPauseAtTick({
      schedule: null,
      enabled: true,
      nowMs: tsAtUtcHour(3),
      timezoneOffsetMinutes: 0,
    });
    expect(r).toEqual({ paused: false, reason: "no_schedule" });
  });

  it("never pauses when EMPTY_SCHEDULE is supplied (every hour active)", () => {
    const r = decideAutoPauseAtTick({
      schedule: EMPTY_SCHEDULE,
      enabled: true,
      nowMs: tsAtUtcHour(3),
      timezoneOffsetMinutes: 0,
    });
    expect(r.paused).toBe(false);
    expect(r.reason).toBe("active_hour");
  });
});

describe("decideAutoPauseAtTick — quiet/active classification", () => {
  it("pauses during a quiet hour", () => {
    const r = decideAutoPauseAtTick({
      schedule: scheduleWithQuietHours([2, 3, 4]),
      enabled: true,
      nowMs: tsAtUtcHour(3),
      timezoneOffsetMinutes: 0,
    });
    expect(r.paused).toBe(true);
    if (r.paused) {
      expect(r.reason).toBe("quiet_hour");
      expect(r.resumesAtMs).toBe(tsAtUtcHour(5));
    }
  });

  it("does not pause during an active hour", () => {
    const r = decideAutoPauseAtTick({
      schedule: scheduleWithQuietHours([2, 3, 4]),
      enabled: true,
      nowMs: tsAtUtcHour(10),
      timezoneOffsetMinutes: 0,
    });
    expect(r).toEqual({ paused: false, reason: "active_hour" });
  });

  it("returns null resumesAtMs when every hour is quiet (degenerate)", () => {
    const allQuiet = scheduleWithQuietHours(
      Array.from({ length: 24 }, (_v, i) => i),
    );
    const r = decideAutoPauseAtTick({
      schedule: allQuiet,
      enabled: true,
      nowMs: tsAtUtcHour(3),
      timezoneOffsetMinutes: 0,
    });
    expect(r.paused).toBe(true);
    if (r.paused) expect(r.resumesAtMs).toBeNull();
  });
});

describe("decideAutoPauseAtTick — manual resume override", () => {
  it("honours a recent manual resume during what would otherwise be a quiet hour", () => {
    const now = tsAtUtcHour(3);
    const r = decideAutoPauseAtTick({
      schedule: scheduleWithQuietHours([2, 3, 4]),
      enabled: true,
      nowMs: now,
      manualResumedAtMs: now - 5 * 60_000,
      timezoneOffsetMinutes: 0,
    });
    expect(r).toEqual({ paused: false, reason: "manual_resume_active" });
  });

  it("expires the manual override after the TTL elapses", () => {
    const now = tsAtUtcHour(3);
    const r = decideAutoPauseAtTick({
      schedule: scheduleWithQuietHours([2, 3, 4]),
      enabled: true,
      nowMs: now,
      manualResumedAtMs: now - DEFAULT_MANUAL_RESUME_TTL_MS - 1,
      timezoneOffsetMinutes: 0,
    });
    expect(r.paused).toBe(true);
    if (r.paused) expect(r.reason).toBe("quiet_hour");
  });

  it("respects a custom manualResumeTtlMs (e.g. 5 minutes)", () => {
    const now = tsAtUtcHour(3);
    const r = decideAutoPauseAtTick({
      schedule: scheduleWithQuietHours([2, 3, 4]),
      enabled: true,
      nowMs: now,
      manualResumedAtMs: now - 6 * 60_000,
      manualResumeTtlMs: 5 * 60_000,
      timezoneOffsetMinutes: 0,
    });
    expect(r.paused).toBe(true);
  });
});
