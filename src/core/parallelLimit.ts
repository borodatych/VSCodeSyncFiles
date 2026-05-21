/**
 * Bounded parallel iteration helper.
 *
 * Used by the sync engine to process multiple files (within a workspace) or
 * multiple workspaces (within a full sync) concurrently while respecting a
 * user-supplied concurrency cap. A cap of 1 reproduces the historical
 * fully-serial behaviour; higher values amortise provider round-trip latency.
 *
 * The helper preserves input order in the returned array — convenient for
 * callers that aggregate results back into a manifest-shaped structure.
 *
 * Errors are surfaced in two modes:
 *   - `parallelLimit` (fail-fast): the first rejection aborts pulling new
 *     work from the input queue and re-throws to the caller. In-flight tasks
 *     that were already mid-execution at the moment of the first rejection
 *     run to completion; their successful results still land in the output
 *     array but the caller never sees them because the throw shortcuts the
 *     return. (Use `parallelLimitSettle` if you need every result.)
 *   - `parallelLimitSettle`: every task runs to completion. The returned
 *     array contains a discriminated `{ ok, value | error }` for each input.
 *
 * No `vscode` dependency. Unit-testable.
 */

export type ParallelSettleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface ParallelLimitOptions {
  /** Concurrency cap. Clamped to [1, items.length]. */
  concurrency: number;
  /** Optional progress callback fired after each task settles. */
  onProgress?: (settled: number, total: number) => void;
}

/**
 * Fail-fast bounded-concurrency map. Order-preserving.
 *
 * Throws on the first rejection (after in-flight tasks settle).
 */
export async function parallelLimit<I, O>(
  items: readonly I[],
  worker: (item: I, index: number) => Promise<O>,
  opts: ParallelLimitOptions,
): Promise<O[]> {
  const total = items.length;
  if (total === 0) return [];
  const cap = Math.max(1, Math.min(opts.concurrency | 0, total));
  const out: O[] = new Array<O>(total);
  // State is in an object so concurrent runners share by reference and
  // TS doesn't narrow its members across the `await Promise.all(...)` join.
  const state: {
    next: number;
    settled: number;
    firstErr: { err: unknown } | null;
  } = { next: 0, settled: 0, firstErr: null };

  const runOne = async (): Promise<void> => {
    for (;;) {
      if (state.firstErr) return;
      const i = state.next++;
      if (i >= total) return;
      const item = items[i];
      try {
        out[i] = await worker(item, i);
      } catch (e) {
        state.firstErr ??= { err: e };
        return;
      } finally {
        state.settled += 1;
        opts.onProgress?.(state.settled, total);
      }
    }
  };

  const runners: Promise<void>[] = [];
  for (let k = 0; k < cap; k++) runners.push(runOne());
  await Promise.all(runners);
  if (state.firstErr) throw state.firstErr.err;
  return out;
}

/**
 * Settle-all bounded-concurrency map. Order-preserving. Never throws.
 */
export async function parallelLimitSettle<I, O>(
  items: readonly I[],
  worker: (item: I, index: number) => Promise<O>,
  opts: ParallelLimitOptions,
): Promise<ParallelSettleResult<O>[]> {
  const total = items.length;
  if (total === 0) return [];
  const cap = Math.max(1, Math.min(opts.concurrency | 0, total));
  const out: ParallelSettleResult<O>[] = new Array<ParallelSettleResult<O>>(total);
  const state = { next: 0, settled: 0 };

  const runOne = async (): Promise<void> => {
    for (;;) {
      const i = state.next++;
      if (i >= total) return;
      const item = items[i];
      try {
        const value = await worker(item, i);
        out[i] = { ok: true, value };
      } catch (e) {
        out[i] = { ok: false, error: e };
      } finally {
        state.settled += 1;
        opts.onProgress?.(state.settled, total);
      }
    }
  };

  const runners: Promise<void>[] = [];
  for (let k = 0; k < cap; k++) runners.push(runOne());
  await Promise.all(runners);
  return out;
}
