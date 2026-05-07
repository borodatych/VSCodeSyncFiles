import { describe, expect, it } from "vitest";
import {
  parseActiveHours,
  isMinuteWithinWindow,
  normalizeSyncSchedule,
  isWithinSyncSchedule,
  describeScheduleActiveHint,
} from "../../src/core/syncSchedule.js";

describe("parseActiveHours", () => {
  it("parses same-day window", () => {
    expect(parseActiveHours("09:00-18:00")).toEqual({ startMin: 9 * 60, endMin: 18 * 60 });
  });

  it("returns null on invalid", () => {
    expect(parseActiveHours("25:00-18:00")).toBeNull();
    expect(parseActiveHours("bad")).toBeNull();
  });
});

describe("isMinuteWithinWindow", () => {
  it("handles same-day span", () => {
    expect(isMinuteWithinWindow(10 * 60 + 30, 9 * 60, 18 * 60)).toBe(true);
    expect(isMinuteWithinWindow(8 * 60, 9 * 60, 18 * 60)).toBe(false);
  });

  it("handles overnight span", () => {
    const start = 22 * 60;
    const end = 6 * 60;
    expect(isMinuteWithinWindow(23 * 60, start, end)).toBe(true);
    expect(isMinuteWithinWindow(3 * 60, start, end)).toBe(true);
    expect(isMinuteWithinWindow(12 * 60, start, end)).toBe(false);
  });
});

describe("normalizeSyncSchedule", () => {
  it("fills defaults", () => {
    const n = normalizeSyncSchedule({});
    expect(n.enabled).toBe(false);
    expect(n.activeHours).toBe("09:00-18:00");
    expect(n.activeDays.length).toBeGreaterThan(0);
    expect(n.timezone).toBe("auto");
  });
});

describe("describeScheduleActiveHint", () => {
  it("formats hint", () => {
    const n = normalizeSyncSchedule({});
    expect(describeScheduleActiveHint(n)).toContain("09:00");
  });
});

describe("isWithinSyncSchedule (UTC)", () => {
  const prev = process.env.TZ;

  it("respects weekday outside Mon–Fri default when enabled", () => {
    process.env.TZ = "Etc/UTC";
    try {
      const s = normalizeSyncSchedule({
        enabled: true,
        activeHours: "09:00-18:00",
        activeDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        timezone: "Etc/UTC",
      });
      /* Sunday 2026-04-26 12:00 UTC */
      const sunday = new Date(Date.UTC(2026, 3, 26, 12, 0, 0));
      expect(isWithinSyncSchedule(s, sunday)).toBe(false);

      /* Monday 2026-04-27 12:00 UTC */
      const monday = new Date(Date.UTC(2026, 3, 27, 12, 0, 0));
      expect(isWithinSyncSchedule(s, monday)).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = prev;
      }
    }
  });
});
