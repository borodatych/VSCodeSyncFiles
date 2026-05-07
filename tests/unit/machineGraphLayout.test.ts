/**
 * Unit tests for `buildMachineGraph` — pure layout helper for the
 * multi-machine graph webview.
 */
import { describe, it, expect } from "vitest";
import { buildMachineGraph } from "../../src/ui/machineGraphLayout.js";
import type { ActivityEvent } from "../../src/core/activityLog.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function ev(opts: {
  machine: string;
  workspaceId: string;
  workspaceNote?: string;
  hoursAgo?: number;
}): ActivityEvent {
  const at = new Date(NOW - (opts.hoursAgo ?? 1) * 3600_000).toISOString();
  return {
    id: `${opts.machine}-${opts.workspaceId}-${at}`,
    at,
    kind: "push",
    workspaceId: opts.workspaceId,
    workspaceNote: opts.workspaceNote ?? opts.workspaceId,
    relPath: "x.ts",
    machineName: opts.machine,
    provider: "onedrive",
  };
}

describe("buildMachineGraph", () => {
  it("returns empty graph for empty input", () => {
    const g = buildMachineGraph([], { now: NOW });
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.maxEdgeWeight).toBe(0);
  });

  it("creates one machine + one workspace + one edge for a single event", () => {
    const g = buildMachineGraph([ev({ machine: "M1", workspaceId: "ws1" })], { now: NOW });
    expect(g.nodes.filter((n) => n.kind === "machine")).toHaveLength(1);
    expect(g.nodes.filter((n) => n.kind === "workspace")).toHaveLength(1);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toEqual({ from: "M1", to: "ws1", weight: 1 });
  });

  it("aggregates multiple events into edge weight + maxEdgeWeight", () => {
    const events = [
      ev({ machine: "M1", workspaceId: "ws1" }),
      ev({ machine: "M1", workspaceId: "ws1" }),
      ev({ machine: "M1", workspaceId: "ws1" }),
      ev({ machine: "M2", workspaceId: "ws1" }),
    ];
    const g = buildMachineGraph(events, { now: NOW });
    const edge = g.edges.find((e) => e.from === "M1" && e.to === "ws1");
    expect(edge?.weight).toBe(3);
    expect(g.maxEdgeWeight).toBe(3);
  });

  it("ignores events older than the window", () => {
    const old = ev({ machine: "M-old", workspaceId: "ws-old", hoursAgo: 24 * 60 });
    const fresh = ev({ machine: "M1", workspaceId: "ws1", hoursAgo: 1 });
    const g = buildMachineGraph([old, fresh], { now: NOW, windowMs: 7 * 24 * 3600_000 });
    expect(g.nodes.find((n) => n.id === "M-old")).toBeUndefined();
    expect(g.nodes.find((n) => n.id === "M1")).toBeDefined();
  });

  it("ignores events with malformed timestamps", () => {
    const evs: ActivityEvent[] = [
      { ...ev({ machine: "M1", workspaceId: "ws1" }), at: "not-a-date" },
    ];
    expect(buildMachineGraph(evs, { now: NOW }).nodes).toHaveLength(0);
  });

  it("filters nodes below minWeight threshold", () => {
    const events = [
      ev({ machine: "M1", workspaceId: "ws1" }),
      ev({ machine: "M1", workspaceId: "ws1" }),
      ev({ machine: "M-noisy", workspaceId: "ws1" }), // single event, below threshold
    ];
    const g = buildMachineGraph(events, { now: NOW, minWeight: 2 });
    expect(g.nodes.find((n) => n.id === "M-noisy")).toBeUndefined();
    // Edge to M-noisy must also be dropped.
    expect(g.edges.find((e) => e.from === "M-noisy")).toBeUndefined();
  });

  it("places machines on the outer ring and workspaces on the inner ring", () => {
    const events = [
      ev({ machine: "M1", workspaceId: "ws1" }),
      ev({ machine: "M2", workspaceId: "ws2" }),
    ];
    const g = buildMachineGraph(events, { now: NOW, width: 400, height: 400 });
    const cx = 200;
    const cy = 200;
    for (const n of g.nodes) {
      const r = Math.hypot(n.x - cx, n.y - cy);
      if (n.kind === "machine") {
        expect(r).toBeGreaterThan(150); // outer ≈ 168
      } else {
        expect(r).toBeLessThan(120); // inner ≈ 88
        expect(r).toBeGreaterThan(50);
      }
    }
  });

  it("uses workspaceNote for label when available", () => {
    const events = [
      ev({ machine: "M", workspaceId: "ws-uuid-abc", workspaceNote: "frontend-app" }),
    ];
    const g = buildMachineGraph(events, { now: NOW });
    const ws = g.nodes.find((n) => n.kind === "workspace");
    expect(ws?.kind === "workspace" && ws.note).toBe("frontend-app");
  });
});
