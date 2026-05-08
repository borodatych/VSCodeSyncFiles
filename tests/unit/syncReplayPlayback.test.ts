import { describe, expect, it } from "vitest";
import {
  eventsToReleasePerTick,
  filterReplayEvents,
  makeReplayCursor,
  seekReplayByTime,
  stepReplayCursor,
  type ReplayEvent,
} from "../../src/core/syncReplayPlayback.js";

const events: ReplayEvent[] = [
  { tsMs: 100, kind: "push", relPath: "a.ts", machineName: "alpha" },
  { tsMs: 200, kind: "pull", relPath: "b.ts", machineName: "beta" },
  { tsMs: 300, kind: "push", relPath: "a.ts", machineName: "alpha" },
  { tsMs: 400, kind: "conflict", relPath: "c.ts", machineName: "alpha" },
];

describe("makeReplayCursor + stepReplayCursor", () => {
  it("starts at 0, advances by one, lands atEnd at total", () => {
    let c = makeReplayCursor(events.length);
    expect(c.next).toBe(0);
    expect(c.atEnd).toBe(false);
    while (!c.atEnd) {
      const next = stepReplayCursor(c);
      if (!next) break;
      c = next;
    }
    expect(c.next).toBe(events.length);
    expect(c.atEnd).toBe(true);
  });

  it("clamps out-of-range start", () => {
    expect(makeReplayCursor(3, -5).next).toBe(0);
    expect(makeReplayCursor(3, 99).next).toBe(3);
  });

  it("stepReplayCursor at end returns null", () => {
    const c = makeReplayCursor(2, 2);
    expect(stepReplayCursor(c)).toBeNull();
  });
});

describe("filterReplayEvents", () => {
  it("filters by kind", () => {
    const r = filterReplayEvents(events, { kinds: ["push"] });
    expect(r).toHaveLength(2);
  });

  it("filters by file", () => {
    const r = filterReplayEvents(events, { files: ["b.ts", "c.ts"] });
    expect(r).toHaveLength(2);
  });

  it("filters by machine", () => {
    const r = filterReplayEvents(events, { machines: ["beta"] });
    expect(r).toHaveLength(1);
  });

  it("combines filters with AND semantics", () => {
    const r = filterReplayEvents(events, { kinds: ["push"], files: ["a.ts"] });
    expect(r).toHaveLength(2);
    const r2 = filterReplayEvents(events, { kinds: ["pull"], files: ["a.ts"] });
    expect(r2).toHaveLength(0);
  });
});

describe("seekReplayByTime", () => {
  it("lands at first event >= seekTo", () => {
    expect(seekReplayByTime(events, 250).next).toBe(2);
  });

  it("seeks to 0 when seekTo is before all events", () => {
    expect(seekReplayByTime(events, 0).next).toBe(0);
  });

  it("seeks to end when seekTo is after all events", () => {
    expect(seekReplayByTime(events, 9999).next).toBe(events.length);
  });
});

describe("eventsToReleasePerTick", () => {
  it("releases zero events when rate is zero", () => {
    expect(eventsToReleasePerTick(0, 1000)).toEqual({ count: 0, nextCarry: 0 });
  });

  it("converts elapsed ms × rate to integer count, carrying remainder", () => {
    const r = eventsToReleasePerTick(10, 100); // 100 ms × 10/s = 1.0
    expect(r.count).toBe(1);
    expect(r.nextCarry).toBeCloseTo(0);
  });

  it("accumulates carry across ticks", () => {
    const t1 = eventsToReleasePerTick(2, 100, 0); // 100ms × 2/s = 0.2 → 0 + carry 0.2
    expect(t1.count).toBe(0);
    const t2 = eventsToReleasePerTick(2, 500, t1.nextCarry); // 500ms × 2/s = 1.0 + 0.2 → 1 release, carry 0.2
    expect(t2.count).toBe(1);
  });
});
