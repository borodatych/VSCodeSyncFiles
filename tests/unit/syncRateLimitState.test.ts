/**
 * Tests for the in-memory rate-limit state used by every cloud provider.
 *
 * Covers:
 *  - `noteProviderRateLimited` honours the explicit Retry-After delay,
 *    falls back to exponential backoff when no header,
 *    and never shortens an already-longer block.
 *  - `noteProviderRequestSuccess` clears the block and resets the backoff.
 *  - The sliding-window request counter (per-provider).
 *  - `isApproachingRateLimit` triggers at ≥ 90% of the provider's quota.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  PROVIDER_RATE_LIMITS,
  getProviderRequestCount,
  getRateLimitRemainingMs,
  isApproachingRateLimit,
  isAutoSyncBlockedByRateLimit,
  noteProviderApiRequest,
  noteProviderRateLimited,
  noteProviderRequestSuccess,
  resetRateLimitStateForTests,
} from "../../src/core/syncRateLimitState.js";

describe("syncRateLimitState — global block window", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
  });

  it("starts unblocked", () => {
    expect(isAutoSyncBlockedByRateLimit()).toBe(false);
    expect(getRateLimitRemainingMs()).toBe(0);
  });

  it("blocks until delay passes", () => {
    noteProviderRateLimited(50_000);
    expect(isAutoSyncBlockedByRateLimit()).toBe(true);
    expect(getRateLimitRemainingMs()).toBeGreaterThan(45_000);
  });

  it("clears after successful request notification", () => {
    noteProviderRateLimited(60_000);
    expect(isAutoSyncBlockedByRateLimit()).toBe(true);
    noteProviderRequestSuccess();
    expect(isAutoSyncBlockedByRateLimit()).toBe(false);
    expect(getRateLimitRemainingMs()).toBe(0);
  });

  it("does not shorten an already-longer block", () => {
    noteProviderRateLimited(60_000);
    const longer = getRateLimitRemainingMs();
    noteProviderRateLimited(5_000);
    // 5s window must not reduce the existing 60s block.
    expect(getRateLimitRemainingMs()).toBeGreaterThan(longer - 1_000);
  });

  it("falls back to exponential backoff when Retry-After is missing", () => {
    noteProviderRateLimited(undefined);
    expect(isAutoSyncBlockedByRateLimit()).toBe(true);
    expect(getRateLimitRemainingMs()).toBeGreaterThanOrEqual(15_000);
  });

  it("rejects non-finite / non-positive Retry-After values (uses backoff)", () => {
    noteProviderRateLimited(Number.NaN);
    expect(isAutoSyncBlockedByRateLimit()).toBe(true);
    // Must have fallen back to fallbackBackoff (≥ 15s)
    expect(getRateLimitRemainingMs()).toBeGreaterThanOrEqual(15_000);
  });
});

describe("syncRateLimitState — per-provider sliding window", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
  });

  it("starts at 0 for any provider", () => {
    expect(getProviderRequestCount("onedrive", 60_000)).toBe(0);
  });

  it("counts requests within the window", () => {
    noteProviderApiRequest("yandex");
    noteProviderApiRequest("yandex");
    noteProviderApiRequest("yandex");
    expect(getProviderRequestCount("yandex", 60_000)).toBe(3);
  });

  it("is namespaced per provider", () => {
    noteProviderApiRequest("onedrive");
    noteProviderApiRequest("yandex");
    expect(getProviderRequestCount("onedrive", 60_000)).toBe(1);
    expect(getProviderRequestCount("yandex", 60_000)).toBe(1);
  });

  it("isApproachingRateLimit triggers at ≥ 90% of the provider's quota", () => {
    const limit = PROVIDER_RATE_LIMITS.gdrive;
    expect(limit).toBeDefined();
    if (!limit) return;
    expect(isApproachingRateLimit("gdrive")).toBe(false);
    const target = Math.ceil(limit.requests * 0.9);
    for (let i = 0; i < target; i++) {
      noteProviderApiRequest("gdrive");
    }
    expect(isApproachingRateLimit("gdrive")).toBe(true);
  });

  it("isApproachingRateLimit returns false for unknown provider", () => {
    expect(isApproachingRateLimit("not-a-real-provider")).toBe(false);
  });
});
