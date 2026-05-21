import { describe, expect, it } from "vitest";
import {
  EMPTY_TRUSTED_REGISTRY,
  addTrusted,
  isTrusted,
  noteTrustedSeen,
  parseTrustedRegistry,
  removeTrusted,
} from "../../src/core/trustedMachinesRegistry.js";

describe("parseTrustedRegistry", () => {
  it("returns empty on garbage", () => {
    expect(parseTrustedRegistry(null)).toEqual(EMPTY_TRUSTED_REGISTRY);
    expect(parseTrustedRegistry("string")).toEqual(EMPTY_TRUSTED_REGISTRY);
    expect(parseTrustedRegistry({})).toEqual(EMPTY_TRUSTED_REGISTRY);
  });

  it("filters out malformed entries", () => {
    const r = parseTrustedRegistry({
      entries: [
        { machineId: "ok", label: "Work", addedAtIso: "2026-05-21T00:00:00Z" },
        { machineId: "", label: "bad", addedAtIso: "2026-05-21" },
        { label: "no-id", addedAtIso: "x" },
        null,
        "string",
      ],
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.machineId).toBe("ok");
  });
});

describe("addTrusted / removeTrusted / isTrusted", () => {
  it("add then check trust", () => {
    let reg = EMPTY_TRUSTED_REGISTRY;
    expect(isTrusted(reg, "m1")).toBe(false);
    reg = addTrusted(reg, "m1", "Work Laptop", "2026-05-21T00:00:00Z");
    expect(isTrusted(reg, "m1")).toBe(true);
  });

  it("adding same machineId updates label, no duplicate", () => {
    let reg = addTrusted(EMPTY_TRUSTED_REGISTRY, "m1", "old", "2026-05-21T00:00:00Z");
    reg = addTrusted(reg, "m1", "new", "2026-05-21T01:00:00Z");
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0]?.label).toBe("new");
  });

  it("remove drops the entry", () => {
    let reg = addTrusted(EMPTY_TRUSTED_REGISTRY, "m1", "Work", "2026-05-21T00:00:00Z");
    reg = removeTrusted(reg, "m1");
    expect(isTrusted(reg, "m1")).toBe(false);
  });

  it("noteTrustedSeen updates lastSeenIso only for matching id", () => {
    let reg = addTrusted(EMPTY_TRUSTED_REGISTRY, "m1", "Work", "2026-05-21T00:00:00Z");
    reg = addTrusted(reg, "m2", "Home", "2026-05-21T00:00:00Z");
    reg = noteTrustedSeen(reg, "m1", "2026-05-22T00:00:00Z");
    const m1 = reg.entries.find((e) => e.machineId === "m1");
    const m2 = reg.entries.find((e) => e.machineId === "m2");
    expect(m1?.lastSeenIso).toBe("2026-05-22T00:00:00Z");
    expect(m2?.lastSeenIso).toBe("2026-05-21T00:00:00Z");
  });
});
