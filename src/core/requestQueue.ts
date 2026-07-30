/**
 * Global request queue for serializing concurrent cloud API calls.
 * Prevents race conditions when multiple workspace syncs or watch-mode triggers
 * fire simultaneously against the same provider.
 *
 * Usage:
 *   const result = await globalRequestQueue.enqueue(() => provider.uploadFile(...));
 *
 * Each queue is keyed by a namespace string (e.g. provider type) so that operations
 * against different providers may still run in parallel.
 */

/**
 * Default slots per provider. The queue used to default to 1, and every caller
 * created it without options, so all cloud I/O for a provider was strictly
 * serialised: one slow request delayed everything behind it even when the
 * provider was happy to serve more.
 */
export const DEFAULT_QUEUE_CONCURRENCY = 4;

/**
 * Default per-operation deadline. The queue used to default to `0` — meaning no
 * watchdog was armed at all — and `running` is only released when an operation
 * settles. A request that never settled therefore held its slot forever and the
 * queue stopped draining: the extension looked frozen with no error anywhere.
 * The value sits above the 120s data-path fetch timeout so a live transfer is
 * never killed by the queue instead of by its own timeout.
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 150_000;

/**
 * Upper bound on queued work. Past this, enqueuing rejects instead of growing
 * without limit — an unbounded backlog turns one stuck operation into an
 * unbounded memory leak and a stream of operations that can never run in time.
 */
export const DEFAULT_QUEUE_MAX_PENDING = 500;

export interface RequestQueueOptions {
  /** Max concurrent operations for this queue. Default {@link DEFAULT_QUEUE_CONCURRENCY}. */
  concurrency?: number;
  /** Timeout per operation in ms. 0 = no timeout. Default {@link DEFAULT_QUEUE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Max operations waiting for a slot. Default {@link DEFAULT_QUEUE_MAX_PENDING}. */
  maxPending?: number;
}

/** Thrown when the queue is saturated; distinguishable from a provider error. */
export class RequestQueueOverflowError extends Error {
  constructor(readonly maxPending: number) {
    super(`RequestQueue: очередь переполнена (${String(maxPending)} операций ожидают слот)`);
    this.name = "RequestQueueOverflowError";
  }
}

/** Thrown when an operation exceeds the queue deadline. */
export class RequestQueueTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`RequestQueue: операция не завершилась за ${String(timeoutMs)} мс`);
    this.name = "RequestQueueTimeoutError";
  }
}

interface QueueEntry<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class RequestQueue {
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private running = 0;
  /** Operations abandoned by the deadline whose promise may still be in flight. */
  private timedOut = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pending: QueueEntry<any>[] = [];

  constructor(opts: RequestQueueOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_QUEUE_CONCURRENCY);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.maxPending = Math.max(1, opts.maxPending ?? DEFAULT_QUEUE_MAX_PENDING);
  }

  /**
   * Enqueue an async operation. Returns a promise that resolves when the operation completes.
   * If the queue is at capacity, the operation waits until a slot opens; if the
   * backlog is already at `maxPending`, it rejects rather than growing further.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new RequestQueueOverflowError(this.maxPending));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ run: fn, resolve, reject } as QueueEntry<T>);
      this.drain();
    });
  }

  /** Operations dropped by the deadline since the queue was created. */
  get timedOutCount(): number {
    return this.timedOut;
  }

  /**
   * Reject everything waiting for a slot and forget the running count.
   *
   * Used by the "reset request queue" diagnostic: if an operation is wedged in a
   * way the deadline cannot observe, this is the user's way out short of
   * reloading the window. Running operations are not cancelled — nothing in
   * `Promise` allows that — but their slots stop blocking new work.
   */
  reset(): { rejectedPending: number; clearedRunning: number } {
    const rejectedPending = this.pending.length;
    const clearedRunning = this.running;
    while (this.pending.length > 0) {
      const entry = this.pending.shift();
      entry?.reject(new Error("RequestQueue: очередь сброшена пользователем"));
    }
    this.running = 0;
    return { rejectedPending, clearedRunning };
  }

  /** Current number of running operations. */
  get activeCount(): number {
    return this.running;
  }

  /** Number of operations waiting in the queue. */
  get pendingCount(): number {
    return this.pending.length;
  }

  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) break;
      this.running += 1;
      this.execute(entry);
    }
  }

  private execute<T>(entry: QueueEntry<T>): void {
    let settled = false;

    // The slot is released exactly once, by whichever of the operation and the
    // deadline finishes first. Releasing it inside `settle` (rather than only on
    // the operation's own completion) is what stops one wedged request from
    // holding the queue shut forever.
    const settle = (value: T | undefined, err: unknown): void => {
      if (settled) return;
      settled = true;
      this.running -= 1;
      if (err !== undefined) {
        entry.reject(err);
      } else {
        entry.resolve(value as T);
      }
      this.drain();
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        this.timedOut += 1;
        settle(undefined, new RequestQueueTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    }

    const clear = (): void => {
      if (timer !== undefined) clearTimeout(timer);
    };

    let started: Promise<T>;
    try {
      started = entry.run();
    } catch (err: unknown) {
      // A synchronous throw from `fn` would otherwise never reach `settle` and
      // would leak the slot permanently.
      clear();
      settle(undefined, err);
      return;
    }

    started.then(
      (value) => {
        clear();
        settle(value, undefined);
      },
      (err: unknown) => {
        clear();
        settle(undefined, err);
      },
    );
  }
}

// ─── Global singleton map ────────────────────────────────────────────────────

const globalQueues = new Map<string, RequestQueue>();

/**
 * Get (or lazily create) a named global request queue.
 * Recommended namespace: provider type ("onedrive", "gdrive", etc.)
 * or "global" for a single shared queue.
 *
 * @example
 *   const result = await getGlobalQueue("onedrive").enqueue(() => provider.uploadFile(...));
 */
export function getGlobalQueue(namespace: string, opts?: RequestQueueOptions): RequestQueue {
  let q = globalQueues.get(namespace);
  if (!q) {
    q = new RequestQueue(opts);
    globalQueues.set(namespace, q);
  }
  return q;
}

/** Read-only view of one global queue, for diagnostics and support bundles. */
export interface RequestQueueSnapshot {
  readonly namespace: string;
  readonly running: number;
  readonly pending: number;
  readonly timedOut: number;
}

/**
 * Snapshot every global queue. A queue stuck at `running > 0` with a growing
 * `pending` is the signature of the "extension hangs" report: one operation that
 * never settles holds its slot and nothing behind it can start.
 */
export function snapshotGlobalQueues(): RequestQueueSnapshot[] {
  return [...globalQueues.entries()].map(([namespace, q]) => ({
    namespace,
    running: q.activeCount,
    pending: q.pendingCount,
    timedOut: q.timedOutCount,
  }));
}

/** Reset every global queue. Backs the "reset request queue" diagnostic command. */
export function resetAllGlobalQueues(): { rejectedPending: number; clearedRunning: number } {
  let rejectedPending = 0;
  let clearedRunning = 0;
  for (const q of globalQueues.values()) {
    const r = q.reset();
    rejectedPending += r.rejectedPending;
    clearedRunning += r.clearedRunning;
  }
  return { rejectedPending, clearedRunning };
}

/** Remove a queue from the global map (e.g. when provider is switched). */
export function disposeGlobalQueue(namespace: string): void {
  globalQueues.delete(namespace);
}

/** Remove all global queues (e.g. on extension deactivate). */
export function disposeAllGlobalQueues(): void {
  globalQueues.clear();
}
