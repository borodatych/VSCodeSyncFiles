import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_SYNC_MODE,
  describeAutoSyncMode,
  isAutoCheckEnabled,
  parseAutoSyncMode,
} from "../../src/core/autoSyncMode.js";

describe("autoSyncMode", () => {
  it("default is check-only (multi-machine-safe)", () => {
    expect(DEFAULT_AUTO_SYNC_MODE).toBe("check-only");
  });

  it("parse: known values pass through", () => {
    expect(parseAutoSyncMode("off")).toBe("off");
    expect(parseAutoSyncMode("check-only")).toBe("check-only");
  });

  it("parse: legacy 'full' degrades to check-only, not to the default fallback", () => {
    // A machine that missed the one-shot migration must read the old value
    // as the safe mode — same effective behaviour, no accidental "off".
    expect(parseAutoSyncMode("full")).toBe("check-only");
  });

  it("parse: unknown / missing → default", () => {
    expect(parseAutoSyncMode(undefined)).toBe("check-only");
    expect(parseAutoSyncMode("")).toBe("check-only");
    expect(parseAutoSyncMode("legacy")).toBe("check-only");
  });

  it("auto-check gate", () => {
    expect(isAutoCheckEnabled("off")).toBe(false);
    expect(isAutoCheckEnabled("check-only")).toBe(true);
  });

  it("describe returns a non-empty user-facing label", () => {
    for (const m of ["off", "check-only"] as const) {
      const lbl = describeAutoSyncMode(m);
      expect(lbl.length).toBeGreaterThan(5);
    }
  });
});
