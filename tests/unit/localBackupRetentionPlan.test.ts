import { describe, expect, it } from "vitest";
import { planLocalBackupRetention } from "../../src/core/localBackupRetentionPlan.js";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function entry(
  name: string,
  ageDays: number,
  isDirectory = true,
): { name: string; mtimeMs: number; isDirectory: boolean } {
  return { name, mtimeMs: NOW - ageDays * DAY_MS, isDirectory };
}

describe("planLocalBackupRetention — basic", () => {
  it("returns empty plan for no entries", () => {
    const r = planLocalBackupRetention({ entries: [], retentionDays: 7, nowMs: NOW });
    expect(r.keep).toEqual([]);
    expect(r.delete).toEqual([]);
  });

  it("retentionDays = 0 keeps everything (prune disabled)", () => {
    const r = planLocalBackupRetention({
      entries: [entry("very-old", 365)],
      retentionDays: 0,
      nowMs: NOW,
    });
    expect(r.delete).toEqual([]);
    expect(r.keep).toEqual(["very-old"]);
  });

  it("negative retentionDays also disables prune", () => {
    const r = planLocalBackupRetention({
      entries: [entry("very-old", 365)],
      retentionDays: -1,
      nowMs: NOW,
    });
    expect(r.delete).toEqual([]);
  });
});

describe("planLocalBackupRetention — age cutoff", () => {
  it("keeps fresh entries", () => {
    const r = planLocalBackupRetention({
      entries: [entry("fresh", 1), entry("recent", 5)],
      retentionDays: 7,
      nowMs: NOW,
    });
    expect(r.keep.sort()).toEqual(["fresh", "recent"]);
    expect(r.delete).toEqual([]);
  });

  it("drops entries older than retentionDays", () => {
    const r = planLocalBackupRetention({
      entries: [entry("stale", 30), entry("fresh", 1)],
      retentionDays: 7,
      nowMs: NOW,
    });
    expect(r.delete).toEqual(["stale"]);
    expect(r.keep).toEqual(["fresh"]);
  });

  it("entry exactly at the cutoff is kept (mtime >= cutoff)", () => {
    const r = planLocalBackupRetention({
      entries: [entry("edge", 6.999)],
      retentionDays: 7,
      nowMs: NOW,
    });
    expect(r.keep).toEqual(["edge"]);
  });
});

describe("planLocalBackupRetention — non-directory handling", () => {
  it("skips non-directories regardless of mtime", () => {
    const r = planLocalBackupRetention({
      entries: [
        entry("loose-file.txt", 365, false),
        entry("backup-dir", 365, true),
      ],
      retentionDays: 7,
      nowMs: NOW,
    });
    expect(r.keep).toEqual(["loose-file.txt"]);
    expect(r.delete).toEqual(["backup-dir"]);
  });
});

describe("planLocalBackupRetention — bulk", () => {
  it("partitions a mixed set correctly", () => {
    const r = planLocalBackupRetention({
      entries: [
        entry("a-very-old", 90),
        entry("b-old", 14),
        entry("c-borderline", 6),
        entry("d-fresh", 1),
        entry("loose-thing", 60, false),
      ],
      retentionDays: 7,
      nowMs: NOW,
    });
    expect(r.delete.sort()).toEqual(["a-very-old", "b-old"]);
    expect(r.keep.sort()).toEqual(["c-borderline", "d-fresh", "loose-thing"]);
  });
});
