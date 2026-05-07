import { describe, expect, it } from "vitest";
import { isLikelyUnreachableError } from "../../src/utils/networkErrors.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";

describe("isLikelyUnreachableError", () => {
  it("returns true for typical DNS / connection errno codes", () => {
    expect(isLikelyUnreachableError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(true);
    expect(isLikelyUnreachableError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isLikelyUnreachableError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
  });

  it("unwraps nested cause for code", () => {
    const inner = Object.assign(new Error("inner"), { code: "EAI_AGAIN" });
    const outer = new Error("outer", { cause: inner });
    expect(isLikelyUnreachableError(outer)).toBe(true);
  });

  it("maps ProviderError NETWORK_ERROR to unreachable", () => {
    expect(isLikelyUnreachableError(new ProviderError("NETWORK_ERROR", "down"))).toBe(true);
  });

  it("excludes auth, rate limit, and ETag conflicts", () => {
    expect(isLikelyUnreachableError(new ProviderError("UNAUTHORIZED", "no"))).toBe(false);
    expect(isLikelyUnreachableError(new ProviderError("RATE_LIMITED", "slow"))).toBe(false);
    expect(isLikelyUnreachableError(new ProviderError("PRECONDITION_FAILED", "412"))).toBe(false);
  });

  it("treats typical fetch TypeErrors as unreachable", () => {
    expect(isLikelyUnreachableError(new TypeError("fetch failed"))).toBe(true);
    expect(isLikelyUnreachableError(new TypeError("NetworkError when attempting to fetch"))).toBe(true);
  });
});
