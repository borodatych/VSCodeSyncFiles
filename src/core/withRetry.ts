/**
 * v0.9 — pure retry helper for provider operations.
 *
 * Uses the existing `ExponentialBackoff` for delay and the typed
 * `ProviderErrorCode` enum to classify what's retry-able.
 *
 * Retry-able:
 *   - `NETWORK_ERROR`     — transient transport failure
 *   - `SERVER_ERROR`      — 5xx from provider
 *   - `RATE_LIMITED`      — uses `retryAfterMs` when set
 *   - `INTEGRITY_FAILED`  — caller may retry the upload/download
 *
 * NOT retry-able:
 *   - `PRECONDITION_FAILED`  (caller must reconcile with cloud state)
 *   - `UNAUTHORIZED`         (caller must reauth)
 *   - `NOT_FOUND`            (caller must repair / detach)
 *   - `STORAGE_QUOTA_EXCEEDED` (no point retrying)
 *
 * Non-`ProviderError` exceptions are treated as one-shot failures and
 * surface immediately — keeps host bugs visible.
 */

import { ExponentialBackoff } from "./exponentialBackoff.js";
import { ProviderError, type ProviderErrorCode } from "../providers/cloudProviderTypes.js";

export interface WithRetryOptions {
  /** Logical label for diagnostics — e.g. `"gdrive.uploadFile"`. */
  op: string;
  /** Max attempts including the first. Default 3. Clamp to [1, 10]. */
  maxAttempts?: number;
  /** Initial delay ms for exponential backoff. Default 500. */
  initialDelayMs?: number;
  /** Factor between attempts. Default 2. */
  factor?: number;
  /** Cap on delay (ms). Default 30s. */
  maxDelayMs?: number;
  /** When true, ±20% jitter is applied to each delay. Default true. */
  jitter?: boolean;
  /** Override the classifier. Default = `isRetryable`. */
  classify?: (e: unknown) => boolean;
  /**
   * Called between attempts with the classified error and the chosen delay.
   * Useful for `verboseLog` / telemetry without polluting the helper.
   */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** Override sleep (for tests). Default: `setTimeout`-backed. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "RATE_LIMITED",
  "INTEGRITY_FAILED",
]);

export function isRetryable(e: unknown): boolean {
  if (e instanceof ProviderError) {
    return RETRYABLE_CODES.has(e.code);
  }
  return false;
}

const defaultSleep = (ms: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export async function withRetry<T>(opts: WithRetryOptions, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(10, opts.maxAttempts ?? 3));
  const backoff = new ExponentialBackoff(
    Math.max(0, opts.initialDelayMs ?? 500),
    Math.max(1, opts.factor ?? 2),
    Math.max(1, opts.maxDelayMs ?? 30_000),
  );
  const classify = opts.classify ?? isRetryable;
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitter !== false;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts) break;
      if (!classify(e)) break;
      let delayMs = backoff.nextDelayMs();
      if (e instanceof ProviderError && e.code === "RATE_LIMITED" && typeof e.retryAfterMs === "number") {
        delayMs = Math.max(delayMs, e.retryAfterMs);
      }
      if (jitter) {
        const factor = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
        delayMs = Math.floor(delayMs * factor);
      }
      opts.onRetry?.(attempt, delayMs, e);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastErr;
}
