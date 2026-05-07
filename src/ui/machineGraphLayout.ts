/**
 * Pure data-shape and layout helper for the multi-machine graph webview.
 *
 * Builds nodes (machines + workspaces) and edges (which machine touched which
 * workspace) from the Activity Feed. Layout is deterministic — circular for
 * machines, internal radial for workspaces — so the webview gets stable
 * coordinates without bringing in d3 or vis-network.
 *
 * Vscode-free: covered by unit tests.
 */
import type { ActivityEvent } from "../core/activityLog.js";

export interface GraphNodeMachine {
  kind: "machine";
  id: string;
  name: string;
  x: number;
  y: number;
  /** Number of events this machine produced in the input window. */
  weight: number;
}

export interface GraphNodeWorkspace {
  kind: "workspace";
  id: string;
  note: string;
  x: number;
  y: number;
  weight: number;
}

export type GraphNode = GraphNodeMachine | GraphNodeWorkspace;

export interface GraphEdge {
  /** machine id */
  from: string;
  /** workspace id */
  to: string;
  /** Number of events linking machine ↔ workspace. */
  weight: number;
}

export interface MachineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Convenient max-edge weight — webview uses it to scale stroke width. */
  maxEdgeWeight: number;
}

export interface BuildOptions {
  /** Skip events older than this many milliseconds. Default 30 days. */
  windowMs?: number;
  /** Drop machine/workspace nodes with fewer than this many events. */
  minWeight?: number;
  /** Layout viewport. Centred on (0,0). Default 400×300. */
  width?: number;
  height?: number;
  /** Time anchor — pass `Date.now()` in production, fixed value in tests. */
  now?: number;
}

const DEFAULT_OPTIONS: Required<BuildOptions> = {
  windowMs: 30 * 24 * 3600_000,
  minWeight: 1,
  width: 400,
  height: 300,
  now: 0, // overwritten below
};

export function buildMachineGraph(
  events: readonly ActivityEvent[],
  opts: BuildOptions = {},
): MachineGraph {
  const o: Required<BuildOptions> = {
    ...DEFAULT_OPTIONS,
    now: opts.now ?? Date.now(),
    ...opts,
  };
  const cutoff = o.now - o.windowMs;

  // 1. Aggregate.
  const machineWeight = new Map<string, number>();
  const workspaceWeight = new Map<string, number>();
  const workspaceNote = new Map<string, string>();
  const edgeWeight = new Map<string, number>(); // key = machineId|workspaceId

  for (const ev of events) {
    const t = Date.parse(ev.at);
    if (Number.isNaN(t) || t < cutoff) continue;
    const m = ev.machineName;
    const w = ev.workspaceId;
    machineWeight.set(m, (machineWeight.get(m) ?? 0) + 1);
    workspaceWeight.set(w, (workspaceWeight.get(w) ?? 0) + 1);
    if (ev.workspaceNote && !workspaceNote.has(w)) workspaceNote.set(w, ev.workspaceNote);
    const k = `${m}|${w}`;
    edgeWeight.set(k, (edgeWeight.get(k) ?? 0) + 1);
  }

  // 2. Filter low-weight nodes.
  const machines = [...machineWeight.entries()].filter(([, w]) => w >= o.minWeight);
  const workspaces = [...workspaceWeight.entries()].filter(([, w]) => w >= o.minWeight);

  // 3. Layout: machines around outer ring, workspaces around inner ring.
  const cx = o.width / 2;
  const cy = o.height / 2;
  const outerR = Math.min(o.width, o.height) * 0.42;
  const innerR = Math.min(o.width, o.height) * 0.22;

  const machineNodes: GraphNodeMachine[] = machines.map(([id, weight], i) => {
    const angle = machines.length === 0 ? 0 : (2 * Math.PI * i) / machines.length;
    return {
      kind: "machine",
      id,
      name: id,
      x: cx + outerR * Math.cos(angle),
      y: cy + outerR * Math.sin(angle),
      weight,
    };
  });

  const workspaceNodes: GraphNodeWorkspace[] = workspaces.map(([id, weight], i) => {
    const angle =
      workspaces.length === 0
        ? 0
        : (2 * Math.PI * i) / workspaces.length + Math.PI / Math.max(1, workspaces.length);
    return {
      kind: "workspace",
      id,
      note: workspaceNote.get(id) ?? id,
      x: cx + innerR * Math.cos(angle),
      y: cy + innerR * Math.sin(angle),
      weight,
    };
  });

  // 4. Build edges only between surviving nodes.
  const machineSet = new Set(machineNodes.map((n) => n.id));
  const workspaceSet = new Set(workspaceNodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  let maxEdgeWeight = 0;
  for (const [k, weight] of edgeWeight) {
    const idx = k.indexOf("|");
    if (idx < 0) continue;
    const from = k.slice(0, idx);
    const to = k.slice(idx + 1);
    if (!machineSet.has(from) || !workspaceSet.has(to)) continue;
    edges.push({ from, to, weight });
    if (weight > maxEdgeWeight) maxEdgeWeight = weight;
  }

  return {
    nodes: [...machineNodes, ...workspaceNodes],
    edges,
    maxEdgeWeight,
  };
}
