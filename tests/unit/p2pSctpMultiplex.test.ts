/**
 * v2.20.2 — SCTP lane planner tests.
 */
import { describe, expect, it } from "vitest";
import { createSctpPlanner, planSctpLane } from "../../src/core/p2pSctpMultiplex.js";

describe("planSctpLane", () => {
  it("control payloads always go to lane 0", () => {
    expect(planSctpLane({ kind: "manifest", lanes: 4 }).lane).toBe(0);
    expect(planSctpLane({ kind: "control", lanes: 4 }).lane).toBe(0);
    expect(planSctpLane({ kind: "heartbeat", lanes: 4 }).lane).toBe(0);
  });

  it("file chunks round-robin over lanes [1, lanes-1]", () => {
    const a = planSctpLane({ kind: "file_chunk", stableKey: "fileA", lanes: 4 });
    const b = planSctpLane({ kind: "file_chunk", stableKey: "fileB", lanes: 4 });
    expect(a.lane).toBeGreaterThanOrEqual(1);
    expect(a.lane).toBeLessThanOrEqual(3);
    expect(b.lane).toBeGreaterThanOrEqual(1);
    expect(b.lane).toBeLessThanOrEqual(3);
    expect(a.reason).toBe("round_robin");
  });

  it("same stableKey always lands on the same lane (chunk ordering invariant)", () => {
    const calls = Array.from({ length: 10 }, () =>
      planSctpLane({ kind: "file_chunk", stableKey: "fileA", lanes: 4 }),
    );
    const lanes = new Set(calls.map((c) => c.lane));
    expect(lanes.size).toBe(1);
  });

  it("falls back to single-lane when lanes === 1", () => {
    const a = planSctpLane({ kind: "file_chunk", stableKey: "x", lanes: 1 });
    expect(a.lane).toBe(0);
    expect(a.reason).toBe("single_lane_fallback");
  });

  it("rejects lanes < 1", () => {
    expect(() => planSctpLane({ kind: "manifest", lanes: 0 })).toThrow();
  });
});

describe("createSctpPlanner", () => {
  it("tracks per-lane assignment counts", () => {
    const p = createSctpPlanner(3);
    p.assign({ kind: "manifest" });
    p.assign({ kind: "file_chunk", stableKey: "a" });
    p.assign({ kind: "file_chunk", stableKey: "b" });
    const snap = p.snapshot();
    const total = snap.assignmentsPerLane.reduce((s, x) => s + x, 0);
    expect(total).toBe(3);
    expect(snap.lanes).toBe(3);
    // lane 0 always gets the manifest.
    expect(snap.assignmentsPerLane[0]).toBeGreaterThanOrEqual(1);
  });
});
