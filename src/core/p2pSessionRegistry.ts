/**
 * v2.12.4 — pure in-memory P2P session registry. Bridges the (eventually
 * many) live sessions and the read-only consumers (status bar widget,
 * activity log, future syncEngine.pushFile hook).
 *
 * No `vscode` import. Listeners are notified synchronously on every change so
 * the status bar can re-render without a polling tick.
 */

import type { P2PStatusBarSnapshot } from "./p2pStatusBarFormatter.js";

export interface P2PSessionEntry {
  /** Stable session id — typically `${workspaceId}:${peerMachineId}`. */
  readonly id: string;
  /** Snapshot rendered by `formatP2PStatusBar`. */
  readonly snapshot: P2PStatusBarSnapshot;
}

export type P2PRegistryListener = (entries: readonly P2PSessionEntry[]) => void;

export interface P2PSessionRegistry {
  list(): readonly P2PSessionEntry[];
  /** Returns the highest-severity active session (for the single-bar widget). */
  primary(): P2PSessionEntry | undefined;
  upsert(entry: P2PSessionEntry): void;
  remove(id: string): void;
  subscribe(fn: P2PRegistryListener): () => void;
}

export function createP2PSessionRegistry(): P2PSessionRegistry {
  const entries = new Map<string, P2PSessionEntry>();
  const listeners = new Set<P2PRegistryListener>();

  const notify = (): void => {
    const snap = [...entries.values()];
    for (const fn of listeners) {
      try { fn(snap); } catch { /* listener errors are non-fatal */ }
    }
  };

  const severityRank = (e: P2PSessionEntry): number => {
    // Higher rank = more visible in the single status-bar widget.
    switch (e.snapshot.state.kind) {
      case "connected": return 3;
      case "connecting":
      case "reconnecting": return 2;
      case "disconnected": return 1;
      case "idle": return 0;
    }
  };

  return {
    list(): readonly P2PSessionEntry[] {
      return [...entries.values()];
    },
    primary(): P2PSessionEntry | undefined {
      let best: P2PSessionEntry | undefined;
      for (const e of entries.values()) {
        if (best === undefined || severityRank(e) > severityRank(best)) {
          best = e;
        }
      }
      return best;
    },
    upsert(entry: P2PSessionEntry): void {
      entries.set(entry.id, entry);
      notify();
    },
    remove(id: string): void {
      if (entries.delete(id)) notify();
    },
    subscribe(fn: P2PRegistryListener): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
