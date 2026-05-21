import { describe, expect, it } from "vitest";
import {
  effectiveAutoSyncMode,
  isInsideQuietHours,
  parseHmToMinutes,
} from "../../src/core/autoSyncModeAdaptive.js";

describe("autoSyncModeAdaptive — F5 quiet-hours upgrade", () => {
  describe("parseHmToMinutes", () => {
    it("parses HH:MM forms", () => {
      expect(parseHmToMinutes("00:00")).toBe(0);
      expect(parseHmToMinutes("08:00")).toBe(480);
      expect(parseHmToMinutes("22:30")).toBe(22 * 60 + 30);
      expect(parseHmToMinutes("9:05")).toBe(9 * 60 + 5);
    });
    it("rejects malformed", () => {
      expect(parseHmToMinutes(undefined)).toBeUndefined();
      expect(parseHmToMinutes("")).toBeUndefined();
      expect(parseHmToMinutes("25:00")).toBeUndefined();
      expect(parseHmToMinutes("12:60")).toBeUndefined();
      expect(parseHmToMinutes("noon")).toBeUndefined();
      expect(parseHmToMinutes("12-30")).toBeUndefined();
    });
  });

  describe("isInsideQuietHours", () => {
    const at = (h: number, m = 0): Date => {
      const d = new Date(2026, 4, 21, h, m, 0); // 21 May 2026
      return d;
    };
    it("same-day window", () => {
      const w = { start: "09:00", end: "17:00" };
      expect(isInsideQuietHours(at(8, 59), w)).toBe(false);
      expect(isInsideQuietHours(at(9, 0), w)).toBe(true);
      expect(isInsideQuietHours(at(12, 0), w)).toBe(true);
      expect(isInsideQuietHours(at(16, 59), w)).toBe(true);
      expect(isInsideQuietHours(at(17, 0), w)).toBe(false);
    });
    it("wraps midnight (22:00–08:00)", () => {
      const w = { start: "22:00", end: "08:00" };
      expect(isInsideQuietHours(at(21, 59), w)).toBe(false);
      expect(isInsideQuietHours(at(22, 0), w)).toBe(true);
      expect(isInsideQuietHours(at(23, 30), w)).toBe(true);
      expect(isInsideQuietHours(at(0, 0), w)).toBe(true);
      expect(isInsideQuietHours(at(7, 59), w)).toBe(true);
      expect(isInsideQuietHours(at(8, 0), w)).toBe(false);
    });
    it("rejects empty / malformed window", () => {
      expect(isInsideQuietHours(at(2, 0), {})).toBe(false);
      expect(isInsideQuietHours(at(2, 0), { start: "22:00" })).toBe(false);
      expect(isInsideQuietHours(at(2, 0), { start: "22:00", end: "22:00" })).toBe(false);
      expect(isInsideQuietHours(at(2, 0), { start: "bad", end: "08:00" })).toBe(false);
    });
  });

  describe("effectiveAutoSyncMode", () => {
    const at = (h: number): Date => new Date(2026, 4, 21, h, 0, 0);
    it("no quiet hours — returns user mode unchanged", () => {
      expect(effectiveAutoSyncMode("check-only", undefined, at(2))).toBe("check-only");
      expect(effectiveAutoSyncMode("off", undefined, at(2))).toBe("off");
      expect(effectiveAutoSyncMode("full", undefined, at(2))).toBe("full");
    });
    it("off is sacred — never upgraded", () => {
      expect(
        effectiveAutoSyncMode("off", { start: "22:00", end: "08:00" }, at(2)),
      ).toBe("off");
    });
    it("full stays full", () => {
      expect(
        effectiveAutoSyncMode("full", { start: "22:00", end: "08:00" }, at(2)),
      ).toBe("full");
    });
    it("check-only inside quiet hours upgrades to full", () => {
      const w = { start: "22:00", end: "08:00" };
      expect(effectiveAutoSyncMode("check-only", w, at(23))).toBe("full");
      expect(effectiveAutoSyncMode("check-only", w, at(2))).toBe("full");
      expect(effectiveAutoSyncMode("check-only", w, at(7))).toBe("full");
    });
    it("check-only outside quiet hours stays check-only", () => {
      const w = { start: "22:00", end: "08:00" };
      expect(effectiveAutoSyncMode("check-only", w, at(10))).toBe("check-only");
      expect(effectiveAutoSyncMode("check-only", w, at(15))).toBe("check-only");
      expect(effectiveAutoSyncMode("check-only", w, at(21))).toBe("check-only");
    });
  });
});
