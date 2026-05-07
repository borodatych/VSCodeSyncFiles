/**
 * Tests for the activity-heatmap bucketer used by the Stats Dashboard.
 * Covers: empty, malformed timestamps, UTC vs local mode, peak detection.
 */
import { describe, it, expect } from "vitest";
import {
  bucketActivity,
  describeHeatmap,
  emptyHeatmap,
} from "../../src/ui/activityHeatmap.js";
import type { ActivityEvent } from "../../src/core/activityLog.js";

function ev(at: string): ActivityEvent {
  return {
    id: at,
    at,
    kind: "push",
    workspaceId: "ws",
    workspaceNote: "ws",
    relPath: "file.ts",
    machineName: "m",
    provider: "onedrive",
  };
}

describe("emptyHeatmap", () => {
  it("returns a 7×24 zero matrix", () => {
    const m = emptyHeatmap();
    expect(m).toHaveLength(7);
    for (const row of m) {
      expect(row).toHaveLength(24);
      expect(row.every((v) => v === 0)).toBe(true);
    }
  });
});

describe("bucketActivity", () => {
  it("returns empty matrix for empty input", () => {
    const m = bucketActivity([]);
    expect(describeHeatmap(m).total).toBe(0);
  });

  it("ignores events with malformed timestamps", () => {
    const m = bucketActivity([ev("not-a-date"), ev("")]);
    expect(describeHeatmap(m).total).toBe(0);
  });

  it("buckets a single UTC event correctly when timezone=utc", () => {
    // 2026-04-29T15:30:00Z is a Wednesday → dow=3, hour=15
    const m = bucketActivity([ev("2026-04-29T15:30:00Z")], { timezone: "utc" });
    expect(m[3][15]).toBe(1);
    expect(describeHeatmap(m).total).toBe(1);
  });

  it("multiple events accumulate in the right cells", () => {
    const m = bucketActivity(
      [
        ev("2026-04-29T15:30:00Z"), // wed 15
        ev("2026-04-29T15:45:00Z"), // wed 15
        ev("2026-04-30T03:00:00Z"), // thu 03
      ],
      { timezone: "utc" },
    );
    expect(m[3][15]).toBe(2);
    expect(m[4][3]).toBe(1);
    expect(describeHeatmap(m).total).toBe(3);
  });

  it("peakAt points at the hottest cell", () => {
    const m = bucketActivity(
      [
        ev("2026-04-29T15:00:00Z"),
        ev("2026-04-29T15:15:00Z"),
        ev("2026-04-29T15:30:00Z"),
        ev("2026-04-30T03:00:00Z"),
      ],
      { timezone: "utc" },
    );
    const stats = describeHeatmap(m);
    expect(stats.peakValue).toBe(3);
    expect(stats.peakAt).toEqual({ dow: 3, hour: 15 });
  });

  it("describeHeatmap returns peakAt undefined for empty matrix", () => {
    expect(describeHeatmap(emptyHeatmap()).peakAt).toBeUndefined();
  });
});
