/**
 * Cancellation of a long operation (A5).
 *
 * Until this existed, "Отмена" in a notification could not stop anything: no
 * `AbortSignal` reached the provider or the engine, and the worst case for a
 * single request was three attempts × 120 s timeout plus a `Retry-After` of up
 * to 300 s between them — about sixteen minutes that the user could only wait
 * out. `listFolder` repeated that per page.
 *
 * The signal enters at the command (`withProgress({ cancellable: true })`),
 * travels through the engine as `EnginePorts.abortSignal`, and ends at
 * `fetchWithTimeout`, which already knew how to honour one.
 */

/** Distinguishes "the user stopped this" from a failure. */
export class OperationCancelledError extends Error {
  constructor(readonly operation: string) {
    super(`VSCodeSync: операция «${operation}» отменена.`);
    this.name = "OperationCancelledError";
  }
}

/**
 * Throw if the operation has been cancelled. Call at loop boundaries — between
 * files, between pages — so a cancel takes effect without waiting for whatever
 * is currently in flight to finish on its own.
 */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) {
    throw new OperationCancelledError(operation);
  }
}

/**
 * Has the operation been cancelled?
 *
 * A function rather than an inline `signal?.aborted` check on purpose: the flag
 * flips asynchronously, but TypeScript's flow analysis treats it as a plain
 * readonly property and narrows it to `false` after an earlier check — so the
 * second look inside a retry loop was reported as dead code and would have been
 * "cleaned up" by the next reader.
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** `true` for the cancellation error and for a raw `AbortError` from `fetch`. */
export function isCancellation(e: unknown): boolean {
  if (e instanceof OperationCancelledError) {
    return true;
  }
  return e instanceof Error && e.name === "AbortError";
}

/**
 * Sleep that a cancellation cuts short.
 *
 * `withRetry` used a bare `setTimeout`, so a cancelled operation still sat
 * through the full back-off — up to five minutes — before noticing.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
