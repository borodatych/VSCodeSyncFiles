import { describe, expect, it } from "vitest";
import { decideAdaptiveConcurrency } from "../../src/core/adaptiveConcurrency.js";

describe("decideAdaptiveConcurrency", () => {
  it("no pressure → user value preserved", () => {
    const d = decideAdaptiveConcurrency({}, { userConcurrency: 8 });
    expect(d.resolvedConcurrency).toBe(8);
    expect(d.multiplier).toBe(1);
    expect(d.reasons).toEqual([]);
  });

  it("battery critical (<10%) → 0.25x", () => {
    const d = decideAdaptiveConcurrency(
      { batteryPercent: 8, pluggedIn: false },
      { userConcurrency: 8 },
    );
    expect(d.multiplier).toBe(0.25);
    expect(d.resolvedConcurrency).toBe(2);
    expect(d.reasons).toContain("battery_critical");
  });

  it("battery low (<20%) → 0.5x", () => {
    const d = decideAdaptiveConcurrency(
      { batteryPercent: 15, pluggedIn: false },
      { userConcurrency: 8 },
    );
    expect(d.multiplier).toBe(0.5);
    expect(d.resolvedConcurrency).toBe(4);
  });

  it("battery low BUT plugged in → no reduction", () => {
    const d = decideAdaptiveConcurrency(
      { batteryPercent: 5, pluggedIn: true },
      { userConcurrency: 8 },
    );
    expect(d.multiplier).toBe(1);
  });

  it("RAM >75% → 0.5x", () => {
    const d = decideAdaptiveConcurrency(
      { ramRatio: 0.85 },
      { userConcurrency: 4 },
    );
    expect(d.multiplier).toBe(0.5);
    expect(d.reasons).toContain("ram_high");
  });

  it("multiple pressures stack to lowest", () => {
    const d = decideAdaptiveConcurrency(
      { batteryPercent: 5, pluggedIn: false, ramRatio: 0.9, rateLimited: true },
      { userConcurrency: 8 },
    );
    expect(d.multiplier).toBe(0.25);
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("never goes below 1", () => {
    const d = decideAdaptiveConcurrency(
      { batteryPercent: 1, pluggedIn: false },
      { userConcurrency: 1 },
    );
    expect(d.resolvedConcurrency).toBe(1);
  });

  it("rateLimited alone → 0.5x", () => {
    const d = decideAdaptiveConcurrency(
      { rateLimited: true },
      { userConcurrency: 4 },
    );
    expect(d.multiplier).toBe(0.5);
  });
});
