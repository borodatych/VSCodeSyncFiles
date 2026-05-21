import { describe, expect, it, vi } from "vitest";
import { isRetryable, withRetry } from "../../src/core/withRetry.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";

const noSleep = (): Promise<void> => Promise.resolve();

describe("isRetryable", () => {
  it("network/server/rate-limit/integrity → true", () => {
    expect(isRetryable(new ProviderError("NETWORK_ERROR", "x"))).toBe(true);
    expect(isRetryable(new ProviderError("SERVER_ERROR", "x"))).toBe(true);
    expect(isRetryable(new ProviderError("RATE_LIMITED", "x"))).toBe(true);
    expect(isRetryable(new ProviderError("INTEGRITY_FAILED", "x"))).toBe(true);
  });

  it("auth/not-found/precondition/quota → false", () => {
    expect(isRetryable(new ProviderError("UNAUTHORIZED", "x"))).toBe(false);
    expect(isRetryable(new ProviderError("NOT_FOUND", "x"))).toBe(false);
    expect(isRetryable(new ProviderError("PRECONDITION_FAILED", "x"))).toBe(false);
    expect(isRetryable(new ProviderError("STORAGE_QUOTA_EXCEEDED", "x"))).toBe(false);
  });

  it("non-ProviderError → false", () => {
    expect(isRetryable(new Error("boom"))).toBe(false);
    expect(isRetryable("string")).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns value on first success", async () => {
    const fn = vi.fn(() => Promise.resolve(42));
    const out = await withRetry({ op: "test", sleep: noSleep }, fn);
    expect(out).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retry-able errors then succeeds", async () => {
    let attempts = 0;
    const fn = (): Promise<number> => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new ProviderError("NETWORK_ERROR", "transient"));
      return Promise.resolve("ok" as unknown as number);
    };
    const out = await withRetry({ op: "test", sleep: noSleep, maxAttempts: 5, jitter: false }, fn);
    expect(out).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does NOT retry on non-retryable errors", async () => {
    const fn = vi.fn(() => Promise.reject(new ProviderError("PRECONDITION_FAILED", "etag")));
    await expect(withRetry({ op: "test", sleep: noSleep, maxAttempts: 5 }, fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects maxAttempts cap", async () => {
    const fn = vi.fn(() => Promise.reject(new ProviderError("NETWORK_ERROR", "always")));
    await expect(withRetry({ op: "test", sleep: noSleep, maxAttempts: 3, jitter: false }, fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses retryAfterMs from RATE_LIMITED if larger than backoff", async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => { delays.push(ms); return Promise.resolve(); };
    let calls = 0;
    const fn = (): Promise<string> => {
      calls += 1;
      if (calls < 2) {
        return Promise.reject(new ProviderError("RATE_LIMITED", "throttled", { retryAfterMs: 7777 }));
      }
      return Promise.resolve("ok");
    };
    await withRetry({ op: "test", sleep, jitter: false, initialDelayMs: 100, maxAttempts: 3 }, fn);
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeGreaterThanOrEqual(7777);
  });

  it("calls onRetry between attempts", async () => {
    const onRetry = vi.fn();
    const fn = (): Promise<void> => Promise.reject(new ProviderError("NETWORK_ERROR", "x"));
    await expect(withRetry({ op: "test", sleep: noSleep, maxAttempts: 3, onRetry, jitter: false }, fn)).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(2); // 2 retries between 3 attempts
  });

  it("non-ProviderError surfaces immediately", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("host bug")));
    await expect(withRetry({ op: "test", sleep: noSleep, maxAttempts: 5 }, fn)).rejects.toThrow("host bug");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
