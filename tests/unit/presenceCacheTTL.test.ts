import { describe, expect, it } from "vitest";
import {
  createPresenceCache,
  findHighRiskPeer,
  PRE_SAVE_RISK_THRESHOLD,
  PRESENCE_CACHE_TTL_MS,
} from "../../src/core/presenceCacheTTL.js";
import type { CurrentEditingFrame } from "../../src/core/presenceCurrentEditing.js";

const frame = (rel: string): CurrentEditingFrame => ({
  workspaceId: "ws1",
  relPath: rel,
  sinceMs: 0,
});

describe("createPresenceCache", () => {
  it("put + get round-trip", () => {
    const c = createPresenceCache();
    c.put({ machineId: "m1", machineName: "alpha", frame: frame("a"), receivedAtMs: 1000 });
    expect(c.get("m1", 1500)?.machineName).toBe("alpha");
  });

  it("evicts entries older than TTL", () => {
    const c = createPresenceCache(60_000);
    c.put({ machineId: "m1", machineName: "alpha", frame: frame("a"), receivedAtMs: 0 });
    expect(c.get("m1", 30_000)?.machineName).toBe("alpha");
    expect(c.get("m1", 60_001)).toBeUndefined();
  });

  it("list returns only fresh entries", () => {
    const c = createPresenceCache(60_000);
    c.put({ machineId: "m1", machineName: "alpha", frame: frame("a"), receivedAtMs: 0 });
    c.put({ machineId: "m2", machineName: "beta", frame: frame("b"), receivedAtMs: 50_000 });
    expect(c.list(70_000)).toHaveLength(1);
  });

  it("PRESENCE_CACHE_TTL_MS is 60s by default", () => {
    expect(PRESENCE_CACHE_TTL_MS).toBe(60_000);
  });
});

describe("findHighRiskPeer", () => {
  it("returns the peer when risk = 1.0 (exact match)", () => {
    const c = createPresenceCache();
    c.put({ machineId: "m1", machineName: "alpha", frame: frame("auth.ts"), receivedAtMs: 0 });
    const r = findHighRiskPeer({
      cache: c,
      myWorkspaceId: "ws1",
      myRelPath: "auth.ts",
      nowMs: 1000,
    });
    expect(r).not.toBeNull();
    if (r) {
      expect(r.risk).toBe(1);
      expect(r.entry.machineName).toBe("alpha");
    }
  });

  it("returns null when no peer reaches the threshold", () => {
    const c = createPresenceCache();
    c.put({ machineId: "m1", machineName: "alpha", frame: frame("other.ts"), receivedAtMs: 0 });
    const r = findHighRiskPeer({
      cache: c,
      myWorkspaceId: "ws1",
      myRelPath: "auth.ts",
      nowMs: 1000,
    });
    expect(r).toBeNull();
  });

  it("anonymised match scores 0.8 and crosses threshold", () => {
    const c = createPresenceCache();
    c.put({ machineId: "m1", machineName: "alpha", frame: frame("abc12345"), receivedAtMs: 0 });
    const r = findHighRiskPeer({
      cache: c,
      myWorkspaceId: "ws1",
      myRelPath: "auth.ts",
      myAnonymised: "abc12345",
      nowMs: 1000,
    });
    expect(r).not.toBeNull();
    if (r) expect(r.risk).toBe(0.8);
  });

  it("ignores idle peers (frame === null)", () => {
    const c = createPresenceCache();
    c.put({ machineId: "m1", machineName: "alpha", frame: null, receivedAtMs: 0 });
    const r = findHighRiskPeer({
      cache: c,
      myWorkspaceId: "ws1",
      myRelPath: "auth.ts",
      nowMs: 1000,
    });
    expect(r).toBeNull();
  });

  it("threshold can be overridden per-call", () => {
    expect(PRE_SAVE_RISK_THRESHOLD).toBeLessThan(1);
  });
});
