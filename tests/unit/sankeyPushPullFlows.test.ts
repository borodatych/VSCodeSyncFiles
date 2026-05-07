import { describe, expect, it } from "vitest";
import { buildPushPullFlows } from "../../src/ui/sankeyPushPullFlows.js";
import type { ActivityEvent } from "../../src/core/activityLog.js";

const NOW = Date.parse("2026-05-08T12:00:00.000Z");
const dayMs = 86_400_000;

function ev(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: "x",
    at: new Date(NOW).toISOString(),
    kind: "push",
    workspaceId: "w1",
    workspaceNote: "W1",
    relPath: "a.ts",
    machineName: "alpha",
    provider: "onedrive",
    ...over,
  };
}

describe("buildPushPullFlows — push→pull aggregation", () => {
  it("returns empty when no events", () => {
    expect(buildPushPullFlows([], NOW)).toEqual([]);
  });

  it("attributes pull on workspace W to last machine that pushed to W", () => {
    const events: ActivityEvent[] = [
      ev({ kind: "push", machineName: "alpha", at: new Date(NOW - 2 * dayMs).toISOString() }),
      ev({ kind: "pull", machineName: "beta", at: new Date(NOW - 1 * dayMs).toISOString() }),
    ];
    const flows = buildPushPullFlows(events, NOW);
    expect(flows).toEqual([{ source: "alpha", target: "beta", weight: 1 }]);
  });

  it("ignores self-pulls (same machine)", () => {
    const events: ActivityEvent[] = [
      ev({ kind: "push", machineName: "alpha" }),
      ev({ kind: "pull", machineName: "alpha" }),
    ];
    expect(buildPushPullFlows(events, NOW)).toEqual([]);
  });

  it("ignores pulls without preceding push", () => {
    const events: ActivityEvent[] = [ev({ kind: "pull", machineName: "beta" })];
    expect(buildPushPullFlows(events, NOW)).toEqual([]);
  });

  it("groups multiple pulls into one weighted flow", () => {
    const events: ActivityEvent[] = [
      ev({ kind: "push", machineName: "alpha", at: new Date(NOW - 3 * dayMs).toISOString() }),
      ev({ kind: "pull", machineName: "beta", at: new Date(NOW - 2 * dayMs).toISOString() }),
      ev({ kind: "pull", machineName: "beta", at: new Date(NOW - 1 * dayMs).toISOString() }),
    ];
    const flows = buildPushPullFlows(events, NOW);
    expect(flows).toEqual([{ source: "alpha", target: "beta", weight: 2 }]);
  });

  it("filters out events outside the 30-day window", () => {
    const events: ActivityEvent[] = [
      ev({ kind: "push", machineName: "alpha", at: new Date(NOW - 90 * dayMs).toISOString() }),
      ev({ kind: "pull", machineName: "beta", at: new Date(NOW - 89 * dayMs).toISOString() }),
    ];
    expect(buildPushPullFlows(events, NOW)).toEqual([]);
  });

  it("orders flows by weight desc, then source / target alphabetically", () => {
    const events: ActivityEvent[] = [
      ev({ kind: "push", machineName: "alpha", workspaceId: "w1" }),
      ev({ kind: "push", machineName: "beta", workspaceId: "w2" }),
      ev({ kind: "pull", machineName: "gamma", workspaceId: "w1" }),
      ev({ kind: "pull", machineName: "gamma", workspaceId: "w2" }),
      ev({ kind: "pull", machineName: "gamma", workspaceId: "w2" }),
    ];
    const flows = buildPushPullFlows(events, NOW);
    expect(flows[0]).toEqual({ source: "beta", target: "gamma", weight: 2 });
    expect(flows[1]).toEqual({ source: "alpha", target: "gamma", weight: 1 });
  });
});
