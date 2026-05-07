/** Parse HTTP Retry-After (seconds or HTTP-date) into milliseconds to wait from now. */
export function parseRetryAfterToDelayMs(
  header: string | null | undefined,
  nowMs = Date.now(),
  maxDelayMs = 300_000,
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
