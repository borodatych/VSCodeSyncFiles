/**
 * Tests for the presence classifier used by the Workspaces tree.
 */
import { describe, it, expect } from "vitest";
import {
  classifyPresence,
  describePresence,
  ONLINE_WINDOW_MS,
  RECENT_WINDOW_MS,
} from "../../src/ui/machinePresenceStatus.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

describe("classifyPresence", () => {
  it("offline when undefined", () => {
    expect(classifyPresence(undefined, NOW)).toBe("offline");
  });

  it("offline when malformed", () => {
    expect(classifyPresence("not-a-date", NOW)).toBe("offline");
  });

  it("online when within 5-min window", () => {
    expect(classifyPresence(new Date(NOW - 60_000).toISOString(), NOW)).toBe("online");
    expect(classifyPresence(new Date(NOW - ONLINE_WINDOW_MS + 1).toISOString(), NOW)).toBe(
      "online",
    );
  });

  it("recent when between 5 min and 24h", () => {
    expect(classifyPresence(new Date(NOW - 30 * 60_000).toISOString(), NOW)).toBe("recent");
    expect(
      classifyPresence(new Date(NOW - RECENT_WINDOW_MS + 1).toISOString(), NOW),
    ).toBe("recent");
  });

  it("offline when older than 24h", () => {
    expect(
      classifyPresence(new Date(NOW - 25 * 3600_000).toISOString(), NOW),
    ).toBe("offline");
  });

  it("online when clock skew (lastSeen > now)", () => {
    expect(
      classifyPresence(new Date(NOW + 60_000).toISOString(), NOW),
    ).toBe("online");
  });
});

describe("describePresence", () => {
  it("returns no-record string when undefined", () => {
    expect(describePresence(undefined, NOW)).toMatch(/no record/);
  });

  it("formats fresh timestamp as 'just now'", () => {
    expect(describePresence(new Date(NOW - 30_000).toISOString(), NOW)).toMatch(/just now/);
  });

  it("includes minute count for sub-hour", () => {
    expect(describePresence(new Date(NOW - 10 * 60_000).toISOString(), NOW)).toMatch(/10m ago/);
  });

  it("includes hour count for sub-day", () => {
    expect(describePresence(new Date(NOW - 5 * 3600_000).toISOString(), NOW)).toMatch(/5h ago/);
  });

  it("includes day count for older", () => {
    expect(describePresence(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toMatch(/3d ago/);
  });
});
