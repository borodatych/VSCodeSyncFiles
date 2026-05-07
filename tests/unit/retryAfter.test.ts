import { describe, expect, it } from "vitest";
import { parseRetryAfterToDelayMs } from "../../src/utils/retryAfter.js";

describe("parseRetryAfterToDelayMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterToDelayMs("42", 0, 300_000)).toBe(42_000);
  });

  it("caps delay", () => {
    expect(parseRetryAfterToDelayMs("9999", 0, 50_000)).toBe(50_000);
  });

  it("parses HTTP-date in the future", () => {
    const now = Date.UTC(2026, 3, 29, 12, 0, 0);
    const future = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfterToDelayMs(future, now, 300_000)).toBe(30_000);
  });

  it("returns undefined for empty or invalid", () => {
    expect(parseRetryAfterToDelayMs(null)).toBeUndefined();
    expect(parseRetryAfterToDelayMs("")).toBeUndefined();
    expect(parseRetryAfterToDelayMs("not-a-date")).toBeUndefined();
  });
});
