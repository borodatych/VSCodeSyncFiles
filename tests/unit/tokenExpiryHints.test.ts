/**
 * Tests for `classifyExpiry` and `formatExpiryHint` — pure logic only.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXPIRY_WARN_DAYS,
  classifyExpiry,
  formatExpiryHint,
  MS_PER_DAY,
} from "../../src/core/tokenExpiryHints.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

describe("classifyExpiry", () => {
  it("ok when expiresAt is undefined", () => {
    expect(classifyExpiry(undefined, { now: NOW })).toEqual({ kind: "ok" });
  });

  it("ok when expiry is far in the future (> warn window)", () => {
    const t = NOW + 30 * MS_PER_DAY;
    expect(classifyExpiry(t, { now: NOW })).toEqual({ kind: "ok" });
  });

  it("expiring_soon when within the default 7-day window", () => {
    const t = NOW + 5 * MS_PER_DAY;
    const h = classifyExpiry(t, { now: NOW });
    expect(h.kind).toBe("expiring_soon");
    if (h.kind === "expiring_soon") {
      expect(h.daysUntilExpiry).toBe(5);
    }
  });

  it("respects custom warnWithinDays", () => {
    const t = NOW + 10 * MS_PER_DAY;
    expect(classifyExpiry(t, { now: NOW, warnWithinDays: 14 }).kind).toBe("expiring_soon");
    expect(classifyExpiry(t, { now: NOW, warnWithinDays: 5 }).kind).toBe("ok");
  });

  it("expired when timestamp is in the past", () => {
    const t = NOW - 3 * MS_PER_DAY;
    const h = classifyExpiry(t, { now: NOW });
    expect(h.kind).toBe("expired");
    if (h.kind === "expired") {
      expect(h.daysSinceExpiry).toBe(3);
    }
  });

  it("expired returns 0 days when expiry just passed", () => {
    const t = NOW - 60_000; // 1 min ago
    const h = classifyExpiry(t, { now: NOW });
    expect(h.kind).toBe("expired");
  });

  it("ignores non-finite values gracefully", () => {
    expect(classifyExpiry(Number.NaN, { now: NOW })).toEqual({ kind: "ok" });
    expect(classifyExpiry(Number.POSITIVE_INFINITY, { now: NOW })).toEqual({ kind: "ok" });
  });

  it("DEFAULT_EXPIRY_WARN_DAYS is 7", () => {
    expect(DEFAULT_EXPIRY_WARN_DAYS).toBe(7);
  });
});

describe("formatExpiryHint", () => {
  it("returns null for ok state", () => {
    expect(formatExpiryHint("Yandex.Disk", { kind: "ok" })).toBeNull();
  });

  it("formats expiring_soon message with days remaining", () => {
    const msg = formatExpiryHint("Yandex.Disk", { kind: "expiring_soon", daysUntilExpiry: 5 });
    expect(msg).toMatch(/Yandex\.Disk/);
    expect(msg).toMatch(/5/);
  });

  it("formats expired message with days since", () => {
    const msg = formatExpiryHint("Google Drive", { kind: "expired", daysSinceExpiry: 2 });
    expect(msg).toMatch(/Google Drive/);
    expect(msg).toMatch(/2/);
  });
});
