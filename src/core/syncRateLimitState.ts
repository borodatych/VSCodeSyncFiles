import { ExponentialBackoff } from "./exponentialBackoff.js";

const MAX_WINDOW_MS = 300_000;

const fallbackBackoff = new ExponentialBackoff(15_000, 2, MAX_WINDOW_MS);
let blockedUntilMs = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    fn();
  }
}

/** Call when provider returns 429/503 (or equivalent) with optional Retry-After. */
export function noteProviderRateLimited(retryAfterMs?: number): void {
  const fromHeader =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, MAX_WINDOW_MS)
      : fallbackBackoff.nextDelayMs();
  // +1 ms cushions the sub-ms drift between this Date.now() and a same-tick
  // read in getRateLimitRemainingMs() — without it, a 15 000 ms window can
  // observably read back as 14 999 ms.
  blockedUntilMs = Math.max(blockedUntilMs, Date.now() + fromHeader + 1);
  emit();
}

/** Call after a successful cloud request to clear throttle state. */
export function noteProviderRequestSuccess(): void {
  fallbackBackoff.reset();
  blockedUntilMs = 0;
  emit();
}

export function subscribeRateLimit(listener: () => void): { dispose: () => void } {
  listeners.add(listener);
  return {
    dispose: () => {
      listeners.delete(listener);
    },
  };
}

export function isAutoSyncBlockedByRateLimit(): boolean {
  return Date.now() < blockedUntilMs;
}

/** Milliseconds until auto-sync may resume; 0 if not blocked. */
export function getRateLimitRemainingMs(): number {
  const left = blockedUntilMs - Date.now();
  return left > 0 ? left : 0;
}

/** For tests / extension deactivate. */
export function resetRateLimitStateForTests(): void {
  fallbackBackoff.reset();
  blockedUntilMs = 0;
  requestTimestamps.clear();
  emit();
}

// ─── Per-provider request counter (sliding window) ───────────────────────────

/** Approximate API rate limits per provider (requests / window ms). */
export const PROVIDER_RATE_LIMITS: Partial<Record<string, { requests: number; windowMs: number }>> = {
  onedrive: { requests: 10_000, windowMs: 600_000 },
  gdrive: { requests: 1_000, windowMs: 100_000 },
  yandex: { requests: 1_000, windowMs: 60_000 },
  dropbox: { requests: 5_000, windowMs: 600_000 },
};

/** Max retention window for timestamps (longest window + buffer). */
const MAX_RETENTION_MS = 660_000;

const requestTimestamps = new Map<string, number[]>();

/** Record a single outgoing API request for the given provider. */
export function noteProviderApiRequest(providerType: string): void {
  const now = Date.now();
  let times = requestTimestamps.get(providerType);
  if (!times) {
    times = [];
    requestTimestamps.set(providerType, times);
  }
  times.push(now);
  const cutoff = now - MAX_RETENTION_MS;
  const firstKeep = times.findIndex((t) => t > cutoff);
  if (firstKeep > 0) {
    times.splice(0, firstKeep);
  }
}

/** Count requests for a provider within the last `windowMs` milliseconds. */
export function getProviderRequestCount(providerType: string, windowMs: number): number {
  const times = requestTimestamps.get(providerType);
  if (!times || times.length === 0) return 0;
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (let i = times.length - 1; i >= 0; i--) {
    if ((times[i]) > cutoff) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Returns true when the request count for this provider in its window
 * is ≥ 90% of the known limit. Does NOT block — caller decides.
 */
export function isApproachingRateLimit(providerType: string): boolean {
  const limit = PROVIDER_RATE_LIMITS[providerType];
  if (!limit) return false;
  const count = getProviderRequestCount(providerType, limit.windowMs);
  return count >= limit.requests * 0.9;
}
