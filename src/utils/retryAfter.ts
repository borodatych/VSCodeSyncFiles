/**
 * Ceiling for a single honoured `Retry-After`.
 *
 * It used to be 300 s. Combined with three attempts and a 120 s per-request
 * timeout, one provider call could legitimately occupy about sixteen minutes —
 * and since nothing was cancellable, that is indistinguishable from a freeze
 * for the person looking at the window. A minute is long enough to ride out a
 * real burst limit; beyond that the operation should fail visibly and be
 * retried later rather than sit there.
 */
export const RETRY_AFTER_MAX_DELAY_MS = 60_000;

/** Parse HTTP Retry-After (seconds or HTTP-date) into milliseconds to wait from now. */
export function parseRetryAfterToDelayMs(
  header: string | null | undefined,
  nowMs = Date.now(),
  maxDelayMs = RETRY_AFTER_MAX_DELAY_MS,
): number | undefined {
  if (!header) {
    return undefined;
  }
  const t = header.trim();
  if (/^\d+$/.test(t)) {
    const sec = parseInt(t, 10);
    if (!Number.isFinite(sec) || sec < 0) {
      return undefined;
    }
    return Math.min(sec * 1000, maxDelayMs);
  }
  const abs = Date.parse(t);
  if (Number.isNaN(abs)) {
    return undefined;
  }
  return Math.min(Math.max(0, abs - nowMs), maxDelayMs);
}
