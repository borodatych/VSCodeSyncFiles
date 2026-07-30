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

export interface RequestQueueOptions {
  /** Max concurrent operations for this queue (default: 1 = fully serialized). */
  concurrency?: number;
  /** Timeout per operation in ms. 0 = no timeout. Default: 0. */
  timeoutMs?: number;
}

interface QueueEntry<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class RequestQueue {
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private running = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pending: QueueEntry<any>[] = [];

  constructor(opts: RequestQueueOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.timeoutMs = opts.timeoutMs ?? 0;
  }

  /**
   * Enqueue an async operation. Returns a promise that resolves when the operation completes.
   * If the queue is at capacity, the operation waits until a slot opens.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ run: fn, resolve, reject } as QueueEntry<T>);
      this.drain();
    });
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
        settle(undefined, new Error(`RequestQueue: operation timed out after ${String(this.timeoutMs)}ms`));
      }, this.timeoutMs);
    }

    entry.run().then(
      (value) => {
        if (timer !== undefined) clearTimeout(timer);
        settle(value, undefined);
      },
      (err: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
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
  }));
}

/** Remove a queue from the global map (e.g. when provider is switched). */
export function disposeGlobalQueue(namespace: string): void {
  globalQueues.delete(namespace);
}

/** Remove all global queues (e.g. on extension deactivate). */
export function disposeAllGlobalQueues(): void {
  globalQueues.clear();
}
