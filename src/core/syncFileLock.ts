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
    fire({ type: "enter", op, workspaceRoot, posixRel });
    try {
      return await fn();
    } finally {
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
