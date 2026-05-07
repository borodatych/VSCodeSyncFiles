import { describe, expect, it } from "vitest";
import { buildWeeklyDigest, formatWeeklyDigest } from "../../src/core/insightsWeeklyDigest.js";
import type { ActivityEvent } from "../../src/core/activityLog.js";

const NOW = Date.parse("2026-05-08T12:00:00.000Z");
const dayMs = 86_400_000;

function ev(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: "x",
    at: new Date(NOW).toISOString(),
    kind: "push",
    workspaceId: "wsA",
    workspaceNote: "A",
    relPath: "a.ts",
    machineName: "alpha",
    provider: "onedrive",
    ...over,
  };
}

describe("insightsWeeklyDigest — buildWeeklyDigest", () => {
  it("returns empty digest for no events", () => {
    const d = buildWeeklyDigest({ events: [], nowMs: NOW });
    expect(d.totalEvents).toBe(0);
    expect(d.windowDays).toBe(7);
    expect(d.byDay).toHaveLength(7);
    expect(d.byKind.push).toBe(0);
    expect(d.topFiles).toEqual([]);
  });

  it("filters out events outside the window", () => {
    const old = ev({ at: new Date(NOW - 30 * dayMs).toISOString() });
    const recent = ev({});
    const d = buildWeeklyDigest({ events: [old, recent], nowMs: NOW });
    expect(d.totalEvents).toBe(1);
  });

  it("counts by kind", () => {
    const events = [
      ev({ kind: "push" }),
      ev({ kind: "push" }),
      ev({ kind: "pull" }),
      ev({ kind: "conflict" }),
      ev({ kind: "resolve_keep_mine" }),
    ];
    const d = buildWeeklyDigest({ events, nowMs: NOW });
    expect(d.byKind.push).toBe(2);
    expect(d.byKind.pull).toBe(1);
    expect(d.byKind.conflict).toBe(1);
    expect(d.byKind.resolve_keep_mine).toBe(1);
  });

  it("ranks top files by frequency, ties broken alphabetically", () => {
    const events = [
      ev({ relPath: "src/a.ts" }),
      ev({ relPath: "src/a.ts" }),
      ev({ relPath: "src/b.ts" }),
      ev({ relPath: "src/c.ts" }),
      ev({ relPath: "src/c.ts" }),
    ];
    const d = buildWeeklyDigest({ events, nowMs: NOW });
    expect(d.topFiles[0]).toEqual({ relPath: "src/a.ts", count: 2 });
    expect(d.topFiles[1]).toEqual({ relPath: "src/c.ts", count: 2 });
    expect(d.topFiles[2]).toEqual({ relPath: "src/b.ts", count: 1 });
  });

  it("ranks top machines and top workspaces", () => {
    const events = [
      ev({ machineName: "m1", workspaceId: "w1", workspaceNote: "One" }),
      ev({ machineName: "m1", workspaceId: "w1", workspaceNote: "One" }),
      ev({ machineName: "m2", workspaceId: "w2", workspaceNote: "Two" }),
    ];
    const d = buildWeeklyDigest({ events, nowMs: NOW });
    expect(d.topMachines[0]).toEqual({ machineName: "m1", count: 2 });
    expect(d.topWorkspaces[0]).toEqual({ workspaceId: "w1", workspaceNote: "One", count: 2 });
  });

  it("byDay covers the full window even when quiet days exist", () => {
    const events = [ev({ at: new Date(NOW - 2 * dayMs).toISOString() })];
    const d = buildWeeklyDigest({ events, nowMs: NOW, windowDays: 7 });
    expect(d.byDay).toHaveLength(7);
    expect(d.busiestDay?.count).toBe(1);
    expect(d.quietestDay?.count).toBe(0);
  });

  it("ignores malformed `at` timestamps", () => {
    const events = [ev({ at: "not-a-date" }), ev({})];
    const d = buildWeeklyDigest({ events, nowMs: NOW });
    expect(d.totalEvents).toBe(1);
  });

  it("respects custom windowDays", () => {
    const old = ev({ at: new Date(NOW - 5 * dayMs).toISOString() });
    const recent = ev({});
    const d = buildWeeklyDigest({ events: [old, recent], nowMs: NOW, windowDays: 2 });
    expect(d.totalEvents).toBe(1);
    expect(d.windowDays).toBe(2);
    expect(d.byDay).toHaveLength(2);
  });
});

describe("insightsWeeklyDigest — formatWeeklyDigest", () => {
  it("renders a multi-section text report", () => {
    const events = [ev({ relPath: "src/a.ts", machineName: "m1" })];
    const d = buildWeeklyDigest({ events, nowMs: NOW });
    const text = formatWeeklyDigest(d);
    expect(text).toContain("VSCodeSync — Insights");
    expect(text).toContain("Total events: 1");
    expect(text).toContain("By day:");
    expect(text).toContain("Top files:");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("Top machines:");
  });
});
