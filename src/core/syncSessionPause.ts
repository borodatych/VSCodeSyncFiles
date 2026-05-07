/**
 * Global sync pause for the current VS Code session only (not persisted in config.json).
 * See docs/v1/04-reliability/roadmap.md §4.2.
 */
let paused = false;
const pendingDocKeys = new Set<string>();
const listeners = new Set<() => void>();

function fire(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

function normPath(fsPath: string): string {
  return fsPath.replace(/\\/g, "/").toLowerCase();
}

export interface SyncSessionPauseSubscription {
  dispose(): void;
}

export const syncSessionPause = {
  isPaused(): boolean {
    return paused;
  },

  /**
   * @param v - `true` = pause (clears pending counter for a fresh window); `false` = resume (pending kept until caller clears).
   */
  setPaused(v: boolean): void {
    if (paused === v) {
      return;
    }
    paused = v;
    if (v) {
      pendingDocKeys.clear();
    }
    fire();
  },

  subscribe(listener: () => void): SyncSessionPauseSubscription {
    listeners.add(listener);
    return {
      dispose(): void {
        listeners.delete(listener);
      },
    };
  },

  notePendingDocSave(fsPath: string): void {
    if (!paused) {
      return;
    }
    pendingDocKeys.add(normPath(fsPath));
    fire();
  },

  getPendingDocCount(): number {
    return pendingDocKeys.size;
  },

  clearPendingDocs(): void {
    pendingDocKeys.clear();
    fire();
  },
} as const;
