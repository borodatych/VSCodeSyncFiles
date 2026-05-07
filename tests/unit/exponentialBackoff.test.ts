import { describe, expect, it } from "vitest";
import { ExponentialBackoff } from "../../src/core/exponentialBackoff.js";

describe("ExponentialBackoff", () => {
  it("increases by factor and caps at maxMs", () => {
    const b = new ExponentialBackoff(1000, 2, 3500);
    expect(b.nextDelayMs()).toBe(1000);
    expect(b.nextDelayMs()).toBe(2000);
    expect(b.nextDelayMs()).toBe(3500);
    expect(b.nextDelayMs()).toBe(3500);
  });

  it("reset restores initial step", () => {
    const b = new ExponentialBackoff(500, 2, 10000);
    expect(b.nextDelayMs()).toBe(500);
    b.reset();
    expect(b.nextDelayMs()).toBe(500);
  });
});
