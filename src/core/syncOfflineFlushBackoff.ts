import { ExponentialBackoff } from "./exponentialBackoff.js";
import { onCloudTransportSuccess } from "./syncOfflineHints.js";

const backoff = new ExponentialBackoff(15_000, 2, 300_000);
let nextAttemptAfterMs = 0;

/**
 * After transport failure: delay automatic offline-queue flush attempts (active probing policy).
 */
export function bumpOfflineFlushBackoff(): void {
  nextAttemptAfterMs = Math.max(nextAttemptAfterMs, Date.now() + backoff.nextDelayMs());
}

export function resetOfflineFlushBackoff(): void {
  backoff.reset();
  nextAttemptAfterMs = 0;
}

/** Call when new items are enqueued — retry soon without waiting full backoff. */
export function allowImmediateOfflineFlushRetry(): void {
  backoff.reset();
  nextAttemptAfterMs = 0;
}

export function canAttemptOfflineFlushNow(): boolean {
  return Date.now() >= nextAttemptAfterMs;
}

/**
 * A request that got through means there is nothing left to back off from
 * (E12). The subscription lives here rather than in the provider: transport
 * reports facts, policy decides consequences (F6).
 */
onCloudTransportSuccess(() => {
  resetOfflineFlushBackoff();
});
