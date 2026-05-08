import { describe, expect, it } from "vitest";
import {
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
} from "../../src/core/syncReplayTimeFormatter.js";

const NOW = Date.UTC(2026, 4, 8, 14, 23, 5, 123);
const WINDOW_INTRA_DAY = { windowStartMs: NOW, windowEndMs: NOW + 60_000 };
const WINDOW_CROSS_DAY = { windowStartMs: NOW, windowEndMs: NOW + 26 * 60 * 60_000 };

describe("formatAbsoluteTime", () => {
  it("renders HH:MM:SS.mmm for intra-day windows", () => {
    expect(formatAbsoluteTime(NOW, WINDOW_INTRA_DAY)).toBe("14:23:05.123");
  });

  it("includes the date for cross-day windows", () => {
    expect(formatAbsoluteTime(NOW, WINDOW_CROSS_DAY)).toBe("2026-05-08 14:23:05");
  });

  it("pads single-digit hours / minutes / seconds with zero", () => {
    const ts = Date.UTC(2026, 0, 1, 1, 2, 3, 4);
    expect(formatAbsoluteTime(ts, { windowStartMs: ts, windowEndMs: ts + 1000 })).toBe(
      "01:02:03.004",
    );
  });
});

describe("formatRelativeTime — sub-second", () => {
  it("returns '+0s' for zero delta", () => {
    expect(formatRelativeTime(0)).toBe("+0s");
  });

  it("returns '+0.4s' for 400ms delta", () => {
    expect(formatRelativeTime(400)).toBe("+0.4s");
  });

  it("returns '+0.1s' for 75ms (rounds up to 0.1)", () => {
    expect(formatRelativeTime(75)).toBe("+0.1s");
  });

  it("returns '+0s' for sub-50ms (rounds down to 0)", () => {
    expect(formatRelativeTime(40)).toBe("+0s");
  });

  it("clamps negative delta to zero", () => {
    expect(formatRelativeTime(-100)).toBe("+0s");
  });
});

describe("formatRelativeTime — second / minute / hour scales", () => {
  it("returns '+12s' for 12s delta", () => {
    expect(formatRelativeTime(12_000)).toBe("+12s");
  });

  it("rounds 12.6s up to '+13s'", () => {
    expect(formatRelativeTime(12_600)).toBe("+13s");
  });

  it("returns '+1m 12s' for sub-hour", () => {
    expect(formatRelativeTime(72_000)).toBe("+1m 12s");
  });

  it("omits seconds when minute count is exact", () => {
    expect(formatRelativeTime(180_000)).toBe("+3m");
  });

  it("returns '+2h 5m' for hour-scale", () => {
    expect(formatRelativeTime(2 * 3600_000 + 5 * 60_000)).toBe("+2h 5m");
  });

  it("omits minutes when hour count is exact", () => {
    expect(formatRelativeTime(3 * 3600_000)).toBe("+3h");
  });
});

describe("formatDuration — same scaling without '+' prefix", () => {
  it("strips the leading + sign for headline durations", () => {
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3600_000)).toBe("1h");
  });

  it("clamps negative duration to '0s'", () => {
    expect(formatDuration(-1)).toBe("0s");
  });
});
