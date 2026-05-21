import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_SYNC_MODE,
  describeAutoSyncMode,
  isAutoCheckEnabled,
  isAutoFullSyncEnabled,
  parseAutoSyncMode,
} from "../../src/core/autoSyncMode.js";

describe("autoSyncMode", () => {
  it("default is check-only (multi-machine-safe)", () => {
    expect(DEFAULT_AUTO_SYNC_MODE).toBe("check-only");
  });

  it("parse: known values pass through", () => {
    expect(parseAutoSyncMode("off")).toBe("off");
    expect(parseAutoSyncMode("check-only")).toBe("check-only");
    expect(parseAutoSyncMode("full")).toBe("full");
  });

  it("parse: unknown / missing → default", () => {
    expect(parseAutoSyncMode(undefined)).toBe("check-only");
    expect(parseAutoSyncMode("")).toBe("check-only");
    expect(parseAutoSyncMode("legacy")).toBe("check-only");
  });

  it("auto-check gate", () => {
    expect(isAutoCheckEnabled("off")).toBe(false);
    expect(isAutoCheckEnabled("check-only")).toBe(true);
    expect(isAutoCheckEnabled("full")).toBe(true);
  });

  it("auto-full gate", () => {
    expect(isAutoFullSyncEnabled("off")).toBe(false);
    expect(isAutoFullSyncEnabled("check-only")).toBe(false);
    expect(isAutoFullSyncEnabled("full")).toBe(true);
  });

  it("describe returns a non-empty user-facing label", () => {
    for (const m of ["off", "check-only", "full"] as const) {
      const lbl = describeAutoSyncMode(m);
      expect(lbl.length).toBeGreaterThan(5);
    }
  });
});
