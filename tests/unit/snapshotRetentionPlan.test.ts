import { describe, expect, it } from "vitest";
import { planSnapshotRetention } from "../../src/core/snapshotRetentionPlan.js";
import type { SnapshotInfo } from "../../src/core/snapshotsEngine.js";

const NOW = Date.parse("2026-05-08T12:00:00Z");

function snap(
  name: string,
  ageDays: number,
  category: "user" | "system" = "user",
): SnapshotInfo {
  const created = new Date(NOW - ageDays * 24 * 3600 * 1000).toISOString();
  return {
    name,
    meta: {
      schemaVersion: 1,
      name,
      createdAt: created,
      machineName: "m1",
      files: [],
    },
    category,
  };
}

describe("planSnapshotRetention — empty / trivial", () => {
  it("returns empty plan when no snapshots", () => {
    const r = planSnapshotRetention({
      snapshots: [],
      retentionDays: 30,
      maxPerWorkspace: 10,
      nowMs: NOW,
    });
    expect(r.keep).toEqual([]);
    expect(r.delete).toEqual([]);
    expect(r.reasons).toEqual({});
  });

  it("rejects non-positive retentionDays", () => {
    expect(() =>
      planSnapshotRetention({
        snapshots: [],
        retentionDays: 0,
        maxPerWorkspace: 10,
        nowMs: NOW,
      }),
    ).toThrow();
  });

  it("rejects non-positive maxPerWorkspace", () => {
    expect(() =>
      planSnapshotRetention({
        snapshots: [],
        retentionDays: 30,
        maxPerWorkspace: 0,
        nowMs: NOW,
      }),
    ).toThrow();
  });
});

describe("planSnapshotRetention — age sweep", () => {
  it("keeps snapshots within retention window", () => {
    const r = planSnapshotRetention({
      snapshots: [snap("recent", 5)],
      retentionDays: 30,
      maxPerWorkspace: 10,
      nowMs: NOW,
    });
    expect(r.keep.length).toBe(1);
    expect(r.delete.length).toBe(0);
  });

  it("drops system snapshots older than retention window with age_exceeded reason", () => {
    const r = planSnapshotRetention({
      snapshots: [snap("old", 60, "system"), snap("recent", 5, "system")],
      retentionDays: 30,
      maxPerWorkspace: 10,
      nowMs: NOW,
    });
    expect(r.delete.length).toBe(1);
    expect(r.delete[0].name).toBe("old");
    expect(r.reasons.old).toBe("age_exceeded");
    expect(r.keep.length).toBe(1);
    expect(r.keep[0].name).toBe("recent");
  });

  it("never age-sweeps user snapshots — a manual restore point is a promise (B13)", () => {
    const r = planSnapshotRetention({
      snapshots: [
        snap("user-old", 100),
        snap("auto-old", 100, "system"),
        snap("user-fresh", 5),
      ],
      retentionDays: 30,
      maxPerWorkspace: 10,
      nowMs: NOW,
    });
    expect(r.delete.map((s) => s.name)).toEqual(["auto-old"]);
    expect(r.keep.map((s) => s.name).sort()).toEqual(["user-fresh", "user-old"]);
  });

  it("treats unparseable createdAt as 'keep' (fail-open on bad data)", () => {
    const bad: SnapshotInfo = {
      name: "weird",
      meta: { schemaVersion: 1, name: "weird", createdAt: "not-a-date", machineName: "m", files: [] },
      category: "user",
    };
    const r = planSnapshotRetention({
      snapshots: [bad],
      retentionDays: 30,
      maxPerWorkspace: 10,
      nowMs: NOW,
    });
    expect(r.keep.length).toBe(1);
    expect(r.delete.length).toBe(0);
  });
});

describe("planSnapshotRetention — count cap on user snapshots", () => {
  it("drops oldest user snapshots when count exceeds cap", () => {
    const r = planSnapshotRetention({
      snapshots: [
        snap("u-1", 1),
        snap("u-2", 2),
        snap("u-3", 3),
        snap("u-4", 4),
        snap("u-5", 5),
      ],
      retentionDays: 30,
      maxPerWorkspace: 3,
      nowMs: NOW,
    });
    expect(r.keep.length).toBe(3);
    expect(r.keep.map((s) => s.name).sort()).toEqual(["u-1", "u-2", "u-3"]);
    expect(r.delete.map((s) => s.name).sort()).toEqual(["u-4", "u-5"]);
    expect(r.reasons["u-4"]).toBe("count_exceeded");
    expect(r.reasons["u-5"]).toBe("count_exceeded");
  });

  it("does NOT count system snapshots toward the cap", () => {
    const r = planSnapshotRetention({
      snapshots: [
        snap("auto-1", 1, "system"),
        snap("auto-2", 2, "system"),
        snap("auto-3", 3, "system"),
        snap("u-1", 4),
        snap("u-2", 5),
      ],
      retentionDays: 30,
      maxPerWorkspace: 2,
      nowMs: NOW,
    });
    // Both user snapshots fit under the cap (max=2, current user count=2).
    expect(r.delete).toEqual([]);
  });

  it("system overflow is NEVER dropped by count rule", () => {
    const r = planSnapshotRetention({
      snapshots: [
        snap("auto-1", 1, "system"),
        snap("auto-2", 2, "system"),
        snap("auto-3", 3, "system"),
      ],
      retentionDays: 30,
      maxPerWorkspace: 1,
      nowMs: NOW,
    });
    expect(r.delete).toEqual([]);
    expect(r.keep.length).toBe(3);
  });

  it("count cap applied AFTER age sweep — system drops by age, user only by count", () => {
    const r = planSnapshotRetention({
      snapshots: [
        snap("auto-very-old", 100, "system"),
        snap("u-very-old", 100),
        snap("u-1", 1),
        snap("u-2", 2),
      ],
      retentionDays: 30,
      maxPerWorkspace: 2,
      nowMs: NOW,
    });
    // Age sweep drops only auto-very-old; u-very-old survives it (user tier)
    // and then loses to the count cap as the oldest user snapshot.
    expect(r.delete.map((s) => s.name).sort()).toEqual(["auto-very-old", "u-very-old"]);
    expect(r.reasons["auto-very-old"]).toBe("age_exceeded");
    expect(r.reasons["u-very-old"]).toBe("count_exceeded");
  });
});

describe("planSnapshotRetention — boundary", () => {
  it("snapshot at exactly retention age is kept", () => {
    // Cutoff is `now - 30 days`; snapshots with createdAt > cutoff (i.e. <30 days old) survive.
    const r = planSnapshotRetention({
      snapshots: [snap("edge", 29.99)],
      retentionDays: 30,
      maxPerWorkspace: 100,
      nowMs: NOW,
    });
    expect(r.keep.length).toBe(1);
  });

  it("ordering of input doesn't change the output partition", () => {
    const a = planSnapshotRetention({
      snapshots: [snap("u-3", 3), snap("u-1", 1), snap("u-2", 2)],
      retentionDays: 30,
      maxPerWorkspace: 2,
      nowMs: NOW,
    });
    const b = planSnapshotRetention({
      snapshots: [snap("u-1", 1), snap("u-2", 2), snap("u-3", 3)],
      retentionDays: 30,
      maxPerWorkspace: 2,
      nowMs: NOW,
    });
    expect(a.delete.map((s) => s.name).sort()).toEqual(b.delete.map((s) => s.name).sort());
    expect(a.keep.map((s) => s.name).sort()).toEqual(b.keep.map((s) => s.name).sort());
  });
});
