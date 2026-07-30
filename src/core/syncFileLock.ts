/** Per-file serialization for cloud pull/push (see docs/v1/04-reliability/roadmap.md §4.4). */

export type SyncFileLockOp = "pull" | "push";

export type SyncFileLockEvent =
  | {
      readonly type: "enter";
      readonly op: SyncFileLockOp;
      readonly workspaceRoot: string;
      readonly posixRel: string;
    }
  | {
      readonly type: "leave";
      readonly op: SyncFileLockOp;
      readonly workspaceRoot: string;
      readonly posixRel: string;
    };

type LockListener = (e: SyncFileLockEvent) => void;

const lockListeners = new Set<LockListener>();
const tails = new Map<string, Promise<void>>();
/** Locks whose `fn` has started and not yet finished, keyed like `tails`. */
const heldLocks = new Map<string, { op: SyncFileLockOp; sinceMs: number }>();

function fire(ev: SyncFileLockEvent): void {
  for (const l of lockListeners) {
    try {
      l(ev);
    } catch {
      /* ignore */
    }
  }
}

export function subscribeSyncFileLock(listener: LockListener): () => void {
  lockListeners.add(listener);
  return () => {
    lockListeners.delete(listener);
  };
}

/** One currently-held file lock, for diagnostics and support bundles. */
export interface SyncFileLockSnapshotEntry {
  readonly key: string;
  readonly op: SyncFileLockOp;
  readonly heldForMs: number;
}

/**
 * Locks whose body is running right now, plus how long each has been held.
 * A lock held for minutes is the other half of the "extension hangs" report:
 * `runWithSyncFileLock` has no deadline, so everything queued behind such a
 * lock waits forever.
 */
export function snapshotSyncFileLocks(): SyncFileLockSnapshotEntry[] {
  const now = Date.now();
  return [...heldLocks.entries()].map(([key, v]) => ({
    key,
    op: v.op,
    heldForMs: now - v.sinceMs,
  }));
}

/** Number of per-file FIFO tails retained in memory (never pruned today). */
export function syncFileLockTailCount(): number {
  return tails.size;
}

export function syncFileLockKey(workspaceRoot: string, posixRel: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").toLowerCase();
  const rel = posixRel.replace(/\\/g, "/").toLowerCase();
  return `${root}::${rel}`;
}

/**
 * Run `fn` when no other pull/push for the same (root, posixRel) is running. FIFO order.
 */
export async function runWithSyncFileLock<T>(
  workspaceRoot: string,
  posixRel: string,
  op: SyncFileLockOp,
  fn: () => Promise<T>,
): Promise<T> {
  const k = syncFileLockKey(workspaceRoot, posixRel);
  const prev = tails.get(k) ?? Promise.resolve();
  const run: Promise<T> = prev.then(async () => {
    heldLocks.set(k, { op, sinceMs: Date.now() });
    fire({ type: "enter", op, workspaceRoot, posixRel });
    try {
      return await fn();
    } finally {
      heldLocks.delete(k);
      fire({ type: "leave", op, workspaceRoot, posixRel });
    }
  });
  tails.set(
    k,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
