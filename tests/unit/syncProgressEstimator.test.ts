import { describe, expect, it } from "vitest";
import {
  SyncProgressEstimator,
  formatEta,
} from "../../src/core/syncProgressEstimator.js";

describe("formatEta", () => {
  it("formats common ranges", () => {
    expect(formatEta(-1)).toBe("?");
    expect(formatEta(500)).toBe("<1s");
    expect(formatEta(30_000)).toBe("30s");
    expect(formatEta(150_000)).toBe("2m 30s");
    expect(formatEta(3_900_000)).toBe("1h 05m");
  });
});

describe("SyncProgressEstimator", () => {
  it("returns unknown ETA until 2 samples", () => {
    const est = new SyncProgressEstimator(100);
    const e1 = est.estimate(1_000);
    expect(e1.etaLabel).toBe("?");
    est.note(1, 1_000);
    expect(est.estimate(2_000).etaLabel).toBe("?");
  });

  it("computes ETA after 2+ samples", () => {
    const est = new SyncProgressEstimator(10);
    est.note(2, 1000);
    est.note(4, 3000);
    // 2 files in 2 seconds → 1s/file, 6 remaining → 6s.
    const e = est.estimate(3000);
    expect(e.remaining).toBe(6);
    expect(e.etaMs).toBeGreaterThanOrEqual(5000);
    expect(e.etaMs).toBeLessThanOrEqual(7000);
    expect(e.etaLabel).toContain("s");
  });

  it("'done' label when remaining=0", () => {
    const est = new SyncProgressEstimator(5);
    est.note(5, 1000);
    expect(est.estimate(2000).etaLabel).toBe("done");
  });

  it("'stalled' after long idle without progress", () => {
    const est = new SyncProgressEstimator(10);
    est.note(2, 1000);
    est.note(2, 2000);
    expect(est.estimate(20_000).etaLabel).toBe("stalled");
  });

  it("window drops oldest samples past capacity", () => {
    const est = new SyncProgressEstimator(100);
    for (let i = 0; i < 30; i++) est.note(i, i * 100);
    // Internal window is 20; with 30 inputs only the last 20 survive.
    // Verify estimate still produces a reasonable ETA.
    const e = est.estimate(30 * 100);
    expect(e.remaining).toBe(71);
    expect(e.etaMs).toBeGreaterThan(0);
  });
});
