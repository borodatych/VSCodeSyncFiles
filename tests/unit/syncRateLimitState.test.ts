import { describe, expect, it, beforeEach } from "vitest";
import {
  getRateLimitRemainingMs,
  isAutoSyncBlockedByRateLimit,
  noteProviderRateLimited,
  noteProviderRequestSuccess,
  resetRateLimitStateForTests,
} from "../../src/core/syncRateLimitState.js";

describe("syncRateLimitState", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
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
});
