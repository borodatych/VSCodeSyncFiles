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

/**
 * How long a caller waits for its turn before giving up. Waiting used to be
 * unbounded: if the current holder never finished, every later push/pull of the
 * same file queued behind it silently and forever.
 */
export const SYNC_FILE_LOCK_WAIT_TIMEOUT_MS = 2 * 60_000;

/**
 * How long the lock body may run before the caller is told it failed. The body
 * is a full push/pull — several cloud requests, each already bounded by the
 * request queue — so this is a backstop, not the normal control.
 */
export const SYNC_FILE_LOCK_HOLD_TIMEOUT_MS = 5 * 60_000;

export class SyncFileLockTimeoutError extends Error {
  constructor(
    readonly kind: "wait" | "hold",
    readonly key: string,
    readonly op: SyncFileLockOp,
    readonly timeoutMs: number,
  ) {
    super(
      kind === "wait"
        ? `Не дождались файловой блокировки за ${String(timeoutMs)} мс (${op}, ${key}). ` +
          "Предыдущая операция над этим файлом ещё не завершилась — возможен взаимный вызов push внутри pull."
        : `Операция ${op} над ${key} не завершилась за ${String(timeoutMs)} мс.`,
    );
    this.name = "SyncFileLockTimeoutError";
  }
}

const lockListeners = new Set<LockListener>();
/** Per-key FIFO tail. Entries are removed once nobody is waiting on the key. */
const tails = new Map<string, Promise<void>>();
/** How many callers hold or wait for each key — drives cleanup of `tails`. */
const waiters = new Map<string, number>();
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
 * A lock held for minutes is one half of the "extension hangs" report.
 */
export function snapshotSyncFileLocks(): SyncFileLockSnapshotEntry[] {
  const now = Date.now();
  return [...heldLocks.entries()].map(([key, v]) => ({
    key,
    op: v.op,
    heldForMs: now - v.sinceMs,
  }));
}

/** Number of per-file FIFO tails retained in memory. */
export function syncFileLockTailCount(): number {
  return tails.size;
}

export function syncFileLockKey(workspaceRoot: string, posixRel: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").toLowerCase();
  const rel = posixRel.replace(/\\/g, "/").toLowerCase();
  return `${root}::${rel}`;
}

function withDeadline<T>(p: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(makeError());
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface SyncFileLockOptions {
  /** Override the wait deadline; 0 disables it. */
  waitTimeoutMs?: number;
  /** Override the hold deadline; 0 disables it. */
  holdTimeoutMs?: number;
}

/**
 * Run `fn` when no other pull/push for the same (root, posixRel) is running. FIFO order.
 *
 * Both waiting and running are bounded. Previously neither was: a body that
 * never settled kept its key blocked for the lifetime of the window, every
 * later operation on that file queued behind it in silence, and `tails` grew by
 * one entry per file ever synced and was never pruned.
 *
 * On a hold timeout the caller is rejected — so the UI unblocks and reports a
 * real error — but the key stays blocked until the runaway body actually
 * settles. Releasing it early would let a second push start against a file that
 * the first push is still writing, and a stuck operation is a far cheaper
 * failure than a corrupted file.
 */
export async function runWithSyncFileLock<T>(
  workspaceRoot: string,
  posixRel: string,
  op: SyncFileLockOp,
  fn: () => Promise<T>,
  opts: SyncFileLockOptions = {},
): Promise<T> {
  const k = syncFileLockKey(workspaceRoot, posixRel);
  const waitMs = opts.waitTimeoutMs ?? SYNC_FILE_LOCK_WAIT_TIMEOUT_MS;
  const holdMs = opts.holdTimeoutMs ?? SYNC_FILE_LOCK_HOLD_TIMEOUT_MS;

  const prev = tails.get(k) ?? Promise.resolve();
  waiters.set(k, (waiters.get(k) ?? 0) + 1);

  // The next arrival chains on `gate`, which opens only when our body settles.
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  tails.set(
    k,
    prev.then(
      () => gate,
      () => gate,
    ),
  );

  const releaseKey = (): void => {
    const left = (waiters.get(k) ?? 1) - 1;
    if (left <= 0) {
      waiters.delete(k);
      tails.delete(k);
    } else {
      waiters.set(k, left);
    }
  };

  try {
    await withDeadline(
      prev.then(
        () => undefined,
        () => undefined,
      ),
      waitMs,
      () => new SyncFileLockTimeoutError("wait", k, op, waitMs),
    );
  } catch (e: unknown) {
    // We never entered the body, so open the gate immediately — otherwise the
    // whole key would stay blocked because of a caller that gave up waiting.
    openGate();
    releaseKey();
    throw e;
  }

  heldLocks.set(k, { op, sinceMs: Date.now() });
  fire({ type: "enter", op, workspaceRoot, posixRel });

  let body: Promise<T>;
  try {
    body = fn();
  } catch (e: unknown) {
    heldLocks.delete(k);
    fire({ type: "leave", op, workspaceRoot, posixRel });
    openGate();
    releaseKey();
    throw e;
  }

  // Gate and bookkeeping follow the *real* completion of `fn`, not our deadline.
  void body.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    heldLocks.delete(k);
    fire({ type: "leave", op, workspaceRoot, posixRel });
    openGate();
    releaseKey();
  });

  return withDeadline(body, holdMs, () => new SyncFileLockTimeoutError("hold", k, op, holdMs));
}
