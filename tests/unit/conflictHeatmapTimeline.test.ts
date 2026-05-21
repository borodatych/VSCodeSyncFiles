import { describe, expect, it } from "vitest";
import { buildConflictHeatmapTimeline } from "../../src/core/conflictHeatmapTimeline.js";

describe("buildConflictHeatmapTimeline", () => {
  it("empty input → empty timeline", () => {
    const t = buildConflictHeatmapTimeline({ events: [] });
    expect(t.buckets).toEqual([]);
    expect(t.peak).toBeNull();
    expect(t.total).toBe(0);
  });

  it("groups events by day", () => {
    const t = buildConflictHeatmapTimeline({
      events: [
        { atIso: "2026-05-21T10:00:00Z", posixRel: "a" },
        { atIso: "2026-05-21T20:00:00Z", posixRel: "a" },
        { atIso: "2026-05-22T01:00:00Z", posixRel: "b" },
      ],
    });
    expect(t.buckets).toHaveLength(2);
    expect(t.buckets[0]?.dayIso).toBe("2026-05-21");
    expect(t.buckets[0]?.count).toBe(2);
    expect(t.buckets[1]?.dayIso).toBe("2026-05-22");
  });

  it("identifies peak day", () => {
    const t = buildConflictHeatmapTimeline({
      events: [
        { atIso: "2026-05-21T10:00:00Z", posixRel: "a" },
        { atIso: "2026-05-22T01:00:00Z", posixRel: "b" },
        { atIso: "2026-05-22T02:00:00Z", posixRel: "c" },
        { atIso: "2026-05-22T03:00:00Z", posixRel: "d" },
      ],
    });
    expect(t.peak?.dayIso).toBe("2026-05-22");
    expect(t.peak?.count).toBe(3);
  });

  it("topFiles per bucket sorted by count", () => {
    const t = buildConflictHeatmapTimeline({
      events: [
        { atIso: "2026-05-21T10:00:00Z", posixRel: "popular" },
        { atIso: "2026-05-21T10:00:00Z", posixRel: "popular" },
        { atIso: "2026-05-21T10:00:00Z", posixRel: "popular" },
        { atIso: "2026-05-21T11:00:00Z", posixRel: "rare" },
      ],
    });
    expect(t.buckets[0]?.topFiles[0]?.posixRel).toBe("popular");
    expect(t.buckets[0]?.topFiles[0]?.count).toBe(3);
  });

  it("respects fromIso/toIso window", () => {
    const t = buildConflictHeatmapTimeline({
      events: [
        { atIso: "2026-04-01T00:00:00Z", posixRel: "old" },
        { atIso: "2026-05-21T00:00:00Z", posixRel: "new" },
      ],
      fromIso: "2026-05-01T00:00:00Z",
    });
    expect(t.total).toBe(1);
  });

  it("respects topPerBucket cap", () => {
    const t = buildConflictHeatmapTimeline({
      events: [
        { atIso: "2026-05-21T10:00:00Z", posixRel: "a" },
        { atIso: "2026-05-21T11:00:00Z", posixRel: "b" },
        { atIso: "2026-05-21T12:00:00Z", posixRel: "c" },
      ],
      topPerBucket: 2,
    });
    expect(t.buckets[0]?.topFiles).toHaveLength(2);
  });

  it("skips malformed timestamps", () => {
    const t = buildConflictHeatmapTimeline({
      events: [
        { atIso: "not-a-date", posixRel: "bad" },
        { atIso: "2026-05-21T00:00:00Z", posixRel: "good" },
      ],
    });
    expect(t.total).toBe(1);
  });
});
