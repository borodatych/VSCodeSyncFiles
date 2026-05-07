import { describe, expect, it } from "vitest";

import { DEFAULT_DELTA_THRESHOLD_KB, isDeltaSyncEligible } from "../../src/core/deltaSyncGate.js";

describe("deltaSyncGate", () => {
  it("returns false when deltaSync off", () => {
    expect(
      isDeltaSyncEligible({
        deltaSync: false,
        deltaThresholdKB: 1,
        plaintextByteLength: 999_999,
      }),
    ).toBe(false);
  });

  it("returns false when below threshold", () => {
    expect(
      isDeltaSyncEligible({
        deltaSync: true,
        deltaThresholdKB: DEFAULT_DELTA_THRESHOLD_KB,
        plaintextByteLength: DEFAULT_DELTA_THRESHOLD_KB * 1024 - 1,
      }),
    ).toBe(false);
  });

  it("returns true at threshold boundary", () => {
    expect(
      isDeltaSyncEligible({
        deltaSync: true,
        deltaThresholdKB: DEFAULT_DELTA_THRESHOLD_KB,
        plaintextByteLength: DEFAULT_DELTA_THRESHOLD_KB * 1024,
      }),
    ).toBe(true);
  });

  it("uses DEFAULT_DELTA_THRESHOLD_KB when threshold invalid", () => {
    expect(
      isDeltaSyncEligible({
        deltaSync: true,
        deltaThresholdKB: -1,
        plaintextByteLength: DEFAULT_DELTA_THRESHOLD_KB * 1024,
      }),
    ).toBe(true);
  });
});
