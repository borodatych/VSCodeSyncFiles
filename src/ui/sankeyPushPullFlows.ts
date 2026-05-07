/**
 * Pure aggregation: convert the raw activity log into push→pull flows for the
 * Stats Dashboard sankey. vscode-free so it can be unit-tested in isolation.
 *
 * For each workspace we track the *last* machine that pushed, then attribute
 * subsequent pulls (by other machines) on the same workspace as flowing from
 * that pusher to the puller. Self-pulls and orphan pulls (no preceding push
 * inside the window) are ignored.
 */
import type { ActivityEvent } from "../core/activityLog.js";
import type { SankeyFlowInput } from "../core/sankeyLayout.js";

const WINDOW_MS = 30 * 24 * 3600_000;

export function buildPushPullFlows(events: readonly ActivityEvent[], nowMs: number): SankeyFlowInput[] {
  const cutoff = nowMs - WINDOW_MS;
  const lastPushOnWorkspace = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const ev of events) {
    const t = Date.parse(ev.at);
    if (Number.isNaN(t) || t < cutoff || t > nowMs) continue;
    if (ev.kind === "push") {
      lastPushOnWorkspace.set(ev.workspaceId, ev.machineName);
    } else if (ev.kind === "pull") {
      const from = lastPushOnWorkspace.get(ev.workspaceId);
      if (!from || from === ev.machineName) continue;
      const key = `${from}\x00${ev.machineName}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const flows: SankeyFlowInput[] = [];
  for (const [key, weight] of counts) {
    const sep = key.indexOf("\x00");
    const source = key.slice(0, sep);
    const target = key.slice(sep + 1);
    flows.push({ source, target, weight });
  }
  flows.sort(
    (a, b) =>
      b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
  return flows;
}
