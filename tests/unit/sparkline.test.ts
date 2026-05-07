/**
 * Tests for the sparkline + hourly bucketer used by Status Bar.
 */
import { describe, it, expect } from "vitest";
import { bucketHourly, sparkline } from "../../src/utils/sparkline.js";

describe("sparkline", () => {
  it("empty input → empty string", () => {
    expect(sparkline([])).toBe("");
  });

  it("all-zero input → lowest block repeated", () => {
    const out = sparkline([0, 0, 0, 0]);
    expect(out).toBe("▁▁▁▁");
  });

  it("monotonic increase yields rising block", () => {
    const out = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    // 7 elements ascending - block index proportional. First should be ▁, last should be █.
    expect(out.charAt(0)).toBe("▁");
    expect(out.charAt(out.length - 1)).toBe("█");
  });

  it("single spike has visible peak", () => {
    const out = sparkline([0, 0, 0, 10, 0]);
    expect(out.charAt(3)).toBe("█");
    expect(out.charAt(0)).toBe("▁");
  });

  it("output length matches input length", () => {
    expect(sparkline([1, 2, 3]).length).toBe(3);
    expect(sparkline(new Array<number>(24).fill(0)).length).toBe(24);
  });
});

describe("bucketHourly", () => {
  const endMs = Date.UTC(2026, 5, 1, 12, 0, 0);

  it("empty input → all-zero buckets", () => {
    const out = bucketHourly([], endMs, 24);
    expect(out.length).toBe(24);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("ignores malformed timestamps", () => {
    const out = bucketHourly(["not-a-date", ""], endMs, 24);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("counts a single timestamp into its bucket", () => {
    // Last hour (bucket 23): 30 min before endMs
    const out = bucketHourly([endMs - 30 * 60_000], endMs, 24);
    expect(out[23]).toBe(1);
  });

  it("drops timestamps outside the window", () => {
    const tooOld = endMs - 25 * 3600_000;
    const tooNew = endMs + 60_000;
    const out = bucketHourly([tooOld, tooNew], endMs, 24);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("aggregates multiple events per bucket", () => {
    // Three events 30 min before endMs → all into bucket 23
    const out = bucketHourly(
      [endMs - 30 * 60_000, endMs - 20 * 60_000, endMs - 10 * 60_000],
      endMs,
      24,
    );
    expect(out[23]).toBe(3);
  });

  it("accepts ISO-8601 strings", () => {
    const out = bucketHourly(
      [new Date(endMs - 30 * 60_000).toISOString()],
      endMs,
      24,
    );
    expect(out[23]).toBe(1);
  });
});
