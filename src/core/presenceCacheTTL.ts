/**
 * v2.9.5 — pure TTL cache for `_machines.json.currentEditing` snapshots.
 *
 * The Smart Conflict Prediction reader polls cloud every 60 s; entries older
 * than `PRESENCE_CACHE_TTL_MS` get evicted on each `get` so the auto-dismiss
 * UX is automatic — when peers stop reporting, the warning silently fades.
 *
 * Pure module — no `vscode`, no timer.
 */
import type { CurrentEditingFrame } from "./presenceCurrentEditing.js";

export const PRESENCE_CACHE_TTL_MS = 60_000;

export interface PresenceCacheEntry {
  machineId: string;
  machineName: string;
  frame: CurrentEditingFrame | null;
  receivedAtMs: number;
}

export interface PresenceCache {
  put(entry: PresenceCacheEntry): void;
  get(machineId: string, nowMs?: number): PresenceCacheEntry | undefined;
  list(nowMs?: number): PresenceCacheEntry[];
  /** Drop entries older than TTL. Returns the new size. */
  evict(nowMs?: number): number;
}

export function createPresenceCache(ttlMs: number = PRESENCE_CACHE_TTL_MS): PresenceCache {
  const store = new Map<string, PresenceCacheEntry>();

  function evictOnce(nowMs: number): void {
    for (const [key, entry] of store) {
      if (nowMs - entry.receivedAtMs > ttlMs) store.delete(key);
    }
  }

  return {
    put(entry: PresenceCacheEntry): void {
      store.set(entry.machineId, entry);
    },
    get(machineId, nowMs): PresenceCacheEntry | undefined {
      const now = nowMs ?? Date.now();
      evictOnce(now);
      return store.get(machineId);
    },
    list(nowMs): PresenceCacheEntry[] {
      const now = nowMs ?? Date.now();
      evictOnce(now);
      return [...store.values()];
    },
    evict(nowMs): number {
      const now = nowMs ?? Date.now();
      evictOnce(now);
      return store.size;
    },
  };
}

/** Threshold above which the pre-save modal must fire. */
export const PRE_SAVE_RISK_THRESHOLD = 0.6;

/** Decision helper: given a list of peer presence + my active file, returns
 * the highest-risk peer (or null if no risk crosses the modal threshold). */
export function findHighRiskPeer(
  options: {
    cache: PresenceCache;
    myWorkspaceId: string;
    myRelPath: string;
    myAnonymised?: string;
    nowMs?: number;
    threshold?: number;
  },
): { entry: PresenceCacheEntry; risk: number } | null {
  const threshold = options.threshold ?? PRE_SAVE_RISK_THRESHOLD;
  const peers = options.cache.list(options.nowMs);
  let bestRisk = 0;
  let bestEntry: PresenceCacheEntry | null = null;
  for (const e of peers) {
    if (!e.frame) continue;
    if (e.frame.workspaceId !== options.myWorkspaceId) continue;
    let risk = 0;
    if (e.frame.relPath === options.myRelPath) risk = 1;
    else if (options.myAnonymised !== undefined && e.frame.relPath === options.myAnonymised) {
      risk = 0.8;
    }
    if (risk > bestRisk) {
      bestRisk = risk;
      bestEntry = e;
    }
  }
  if (bestEntry === null || bestRisk < threshold) return null;
  return { entry: bestEntry, risk: bestRisk };
}
