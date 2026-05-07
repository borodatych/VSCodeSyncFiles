import type { ActivityEvent } from "./activityLog.js";
import type { WorkspaceConfig } from "./types.js";

/** Sliding window for co-edit detection (2 weeks). */
export const COEDIT_WINDOW_MS = 14 * 86_400_000;

/** Minimum calendar days (within the window) where two paths both had activity and different workspace IDs. */
export const COEDIT_MIN_SAME_DAY = 5;

/** Prompt archive when last sync older than this (days), only if global `workspaceInactiveDays` is greater. */
export const SMART_SUGGESTIONS_ARCHIVE_DAYS = 60;

export function isCoEditActivityKind(kind: ActivityEvent["kind"]): boolean {
  return kind === "push" || kind === "pull" || kind === "add";
}

function dayKeyLocal(isoAt: string): string {
  const t = Date.parse(isoAt);
  if (Number.isNaN(t)) {
    return "";
  }
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(y)}-${m}-${day}`;
}

function normRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Stable undirected pair id (two lines). */
export function pairKeyPaths(a: string, b: string): string {
  const na = normRel(a);
  const nb = normRel(b);
  return na < nb ? `${na}\n${nb}` : `${nb}\n${na}`;
}

export interface CoEditCluster {
  readonly paths: string[];
  /** Minimum co-occurrence-day count on weighted edges inside the component. */
  readonly score: number;
}

/**
 * Find file groups that often appear on the same calendar day in activity from different `workspaceId`s.
 */
export function analyzeCoEditClusters(
  events: readonly ActivityEvent[],
  nowMs: number,
  opts?: { windowMs?: number; minSameDay?: number },
): CoEditCluster[] {
  const windowMs = opts?.windowMs ?? COEDIT_WINDOW_MS;
  const minSameDay = opts?.minSameDay ?? COEDIT_MIN_SAME_DAY;
  const cutoff = nowMs - windowMs;

  const byDay = new Map<string, Map<string, string>>();
  for (const ev of events) {
    if (!isCoEditActivityKind(ev.kind)) {
      continue;
    }
    const t = Date.parse(ev.at);
    if (Number.isNaN(t) || t < cutoff) {
      continue;
    }
    const dk = dayKeyLocal(ev.at);
    if (!dk) {
      continue;
    }
    const normPath = normRel(ev.relPath);
    let m = byDay.get(dk);
    if (!m) {
      m = new Map();
      byDay.set(dk, m);
    }
    m.set(normPath, ev.workspaceId);
  }

  const pairDays = new Map<string, number>();
  for (const pathMap of byDay.values()) {
    const entries = [...pathMap.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [p1, w1] = entries[i];
        const [p2, w2] = entries[j];
        if (p1 === p2 || w1 === w2) {
          continue;
        }
        const pk = pairKeyPaths(p1, p2);
        pairDays.set(pk, (pairDays.get(pk) ?? 0) + 1);
      }
    }
  }

  interface WeightedEdge {
    a: string;
    b: string;
    w: number;
  }
  const edges: WeightedEdge[] = [];
  for (const [pk, w] of pairDays) {
    if (w < minSameDay) {
      continue;
    }
    const parts = pk.split("\n");
    const a = parts[0];
    const b = parts[1];
    if (a && b) {
      edges.push({ a, b, w });
    }
  }
  if (edges.length === 0) {
    return [];
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) {
      parent.set(rx, ry);
    }
  };

  const edgeWeight = new Map<string, number>();
  for (const e of edges) {
    union(e.a, e.b);
    const pk = pairKeyPaths(e.a, e.b);
    edgeWeight.set(pk, Math.max(edgeWeight.get(pk) ?? 0, e.w));
  }

  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.a);
    nodes.add(e.b);
  }

  const compMembers = new Map<string, string[]>();
  for (const n of nodes) {
    const r = find(n);
    const arr = compMembers.get(r) ?? [];
    arr.push(n);
    compMembers.set(r, arr);
  }

  const out: CoEditCluster[] = [];
  for (const membersRaw of compMembers.values()) {
    if (membersRaw.length < 2) {
      continue;
    }
    const members = [...membersRaw].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
    let minW = Number.POSITIVE_INFINITY;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const pk = pairKeyPaths(members[i], members[j]);
        const w = edgeWeight.get(pk);
        if (w !== undefined && w < minW) {
          minW = w;
        }
      }
    }
    if (!Number.isFinite(minW)) {
      minW = minSameDay;
    }
    out.push({ paths: members, score: minW });
  }

  out.sort((a, b) => b.score - a.score || b.paths.length - a.paths.length);
  return out;
}

/**
 * At least two distinct `workspaceId` values must appear in recent activity for paths in the cluster.
 */
export function clusterHasMultipleWorkspaceIdsInActivity(
  paths: readonly string[],
  events: readonly ActivityEvent[],
  nowMs: number,
  windowMs: number,
): boolean {
  const cutoff = nowMs - windowMs;
  const norm = new Set(paths.map((p) => normRel(p)));
  const wsSeen = new Set<string>();
  for (const ev of events) {
    if (!isCoEditActivityKind(ev.kind)) {
      continue;
    }
    const t = Date.parse(ev.at);
    if (Number.isNaN(t) || t < cutoff) {
      continue;
    }
    if (!norm.has(normRel(ev.relPath))) {
      continue;
    }
    wsSeen.add(ev.workspaceId);
    if (wsSeen.size >= 2) {
      return true;
    }
  }
  return false;
}

/** Fingerprint for dismiss / snooze storage. */
export function coEditClusterFingerprint(paths: readonly string[]): string {
  return [...paths].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).join("|");
}

/**
 * Skip suggestion if every path is already tracked under the same workspace in local configs.
 */
export function clusterAlreadySingleLocalWorkspace(
  paths: readonly string[],
  configs: { wc: WorkspaceConfig }[],
): boolean {
  const norm = paths.map((p) => normRel(p));
  const wsIds = new Set<string>();
  let trackedCount = 0;
  for (const rel of norm) {
    let hit = false;
    for (const { wc } of configs) {
      const fe = wc.files.find((f) => normRel(f.localPath) === rel);
      if (fe) {
        wsIds.add(fe.workspaceId);
        hit = true;
      }
    }
    if (hit) {
      trackedCount += 1;
    }
  }
  if (trackedCount === 0) {
    return false;
  }
  return trackedCount === norm.length && wsIds.size === 1;
}
