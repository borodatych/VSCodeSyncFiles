import { describe, expect, it } from "vitest";
import { evaluateLongAbsence } from "../../src/core/longAbsenceEvaluator.js";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function ago(days: number): number {
  return NOW - days * DAY_MS;
}

describe("evaluateLongAbsence — disabled / empty", () => {
  it("returns nothing when thresholdDays <= 0", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/workspace",
          workspaces: [
            { workspaceId: "w1", workspaceNote: "n", lastSyncMs: ago(30) },
          ],
        },
      ],
      thresholdDays: 0,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });

  it("returns empty when there are no folders", () => {
    const r = evaluateLongAbsence({ folders: [], thresholdDays: 3, nowMs: NOW });
    expect(r).toEqual([]);
  });

  it("skips workspaces with no recorded lastSyncMs (never synced)", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/wsA",
          workspaces: [{ workspaceId: "w-new", workspaceNote: "fresh", lastSyncMs: undefined }],
        },
      ],
      thresholdDays: 3,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });
});

describe("evaluateLongAbsence — threshold", () => {
  it("does not warn for fresh workspaces", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/wsA",
          workspaces: [{ workspaceId: "w1", workspaceNote: "n", lastSyncMs: ago(1) }],
        },
      ],
      thresholdDays: 3,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });

  it("warns for workspaces past the threshold", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/wsA",
          workspaces: [{ workspaceId: "w1", workspaceNote: "stale", lastSyncMs: ago(10) }],
        },
      ],
      thresholdDays: 3,
      nowMs: NOW,
    });
    expect(r.length).toBe(1);
    expect(r[0].workspaceId).toBe("w1");
    expect(r[0].daysSinceLastSync).toBe(10);
  });

  it("borderline at exactly threshold is NOT warned (lastSync >= cutoff is fresh)", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/wsA",
          workspaces: [{ workspaceId: "w1", workspaceNote: "n", lastSyncMs: ago(3) }],
        },
      ],
      thresholdDays: 3,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });
});

describe("evaluateLongAbsence — one-warning-per-folder", () => {
  it("emits at most one warning per folder, picking the staler workspace", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/wsA",
          workspaces: [
            { workspaceId: "w-old", workspaceNote: "n1", lastSyncMs: ago(20) },
            { workspaceId: "w-older", workspaceNote: "n2", lastSyncMs: ago(40) },
          ],
        },
      ],
      thresholdDays: 3,
      nowMs: NOW,
    });
    expect(r.length).toBe(1);
    expect(r[0].workspaceId).toBe("w-older");
    expect(r[0].daysSinceLastSync).toBe(40);
  });

  it("emits one warning per folder when multiple folders are stale", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/wsA",
          workspaces: [{ workspaceId: "wA1", workspaceNote: "x", lastSyncMs: ago(10) }],
        },
        {
          folderPath: "/wsB",
          workspaces: [{ workspaceId: "wB1", workspaceNote: "y", lastSyncMs: ago(15) }],
        },
      ],
      thresholdDays: 3,
      nowMs: NOW,
    });
    expect(r.length).toBe(2);
    expect(r.map((w) => w.folderPath).sort()).toEqual(["/wsA", "/wsB"]);
  });

  it("never produces a warning for a folder where every workspace is fresh", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/wsA",
          workspaces: [
            { workspaceId: "wA1", workspaceNote: "x", lastSyncMs: ago(1) },
            { workspaceId: "wA2", workspaceNote: "y", lastSyncMs: ago(2) },
          ],
        },
        {
          folderPath: "/wsB",
          workspaces: [{ workspaceId: "wB1", workspaceNote: "z", lastSyncMs: ago(20) }],
        },
      ],
      thresholdDays: 3,
      nowMs: NOW,
    });
    expect(r.length).toBe(1);
    expect(r[0].folderPath).toBe("/wsB");
  });
});

describe("evaluateLongAbsence — daysSinceLastSync precision", () => {
  it("floors fractional days", () => {
    const r = evaluateLongAbsence({
      folders: [
        {
          folderPath: "/wsA",
          workspaces: [
            { workspaceId: "w1", workspaceNote: "n", lastSyncMs: ago(7.5) },
          ],
        },
      ],
      thresholdDays: 3,
      nowMs: NOW,
    });
    expect(r[0].daysSinceLastSync).toBe(7);
  });
});
