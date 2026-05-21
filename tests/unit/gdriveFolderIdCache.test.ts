import { describe, expect, it } from "vitest";
import { createGdriveFolderIdCache } from "../../src/core/gdriveFolderIdCache.js";

describe("gdriveFolderIdCache", () => {
  it("returns undefined for unknown path", () => {
    const c = createGdriveFolderIdCache({ ttlMs: 60_000 });
    expect(c.get("VSCodeSyncFiles")).toBeUndefined();
  });

  it("round-trips set/get within TTL", () => {
    let t = 1_000;
    const c = createGdriveFolderIdCache({ ttlMs: 5_000, nowMs: () => t });
    c.set("a/b", "id-123");
    t += 4_000;
    expect(c.get("a/b")).toBe("id-123");
  });

  it("expires entries after TTL", () => {
    let t = 1_000;
    const c = createGdriveFolderIdCache({ ttlMs: 5_000, nowMs: () => t });
    c.set("a/b", "id-1");
    t += 5_001;
    expect(c.get("a/b")).toBeUndefined();
  });

  it("ttlMs = 0 disables the cache (always miss)", () => {
    const c = createGdriveFolderIdCache({ ttlMs: 0 });
    c.set("a/b", "id-1");
    expect(c.get("a/b")).toBeUndefined();
    expect(c.size()).toBe(0);
  });

  it("invalidate drops a specific path", () => {
    const c = createGdriveFolderIdCache({ ttlMs: 60_000 });
    c.set("a/b", "id-1");
    c.set("a/c", "id-2");
    c.invalidate("a/b");
    expect(c.get("a/b")).toBeUndefined();
    expect(c.get("a/c")).toBe("id-2");
  });

  it("invalidatePrefix drops a subtree", () => {
    const c = createGdriveFolderIdCache({ ttlMs: 60_000 });
    c.set("root", "r");
    c.set("root/x", "x");
    c.set("root/x/y", "y");
    c.set("other", "o");
    c.invalidatePrefix("root");
    expect(c.get("root")).toBeUndefined();
    expect(c.get("root/x")).toBeUndefined();
    expect(c.get("root/x/y")).toBeUndefined();
    expect(c.get("other")).toBe("o");
  });

  it("size reflects only live entries", () => {
    let t = 1_000;
    const c = createGdriveFolderIdCache({ ttlMs: 5_000, nowMs: () => t });
    c.set("a", "1");
    c.set("b", "2");
    expect(c.size()).toBe(2);
    t += 5_001;
    expect(c.size()).toBe(0);
  });

  it("clear empties the cache", () => {
    const c = createGdriveFolderIdCache({ ttlMs: 60_000 });
    c.set("a", "1");
    c.set("b", "2");
    c.clear();
    expect(c.size()).toBe(0);
  });
});
