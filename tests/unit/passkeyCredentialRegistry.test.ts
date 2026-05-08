import { describe, expect, it } from "vitest";
import {
  emptyPasskeyRegistry,
  parsePasskeyRegistry,
  upsertCredential,
  removeCredential,
  setPrimaryCredential,
  findPrimaryCredential,
  findCredentialById,
  orderForDisplay,
  noteCredentialUsed,
} from "../../src/core/passkeyCredentialRegistry.js";

const NOW = 1_700_000_000_000;

const E1 = {
  id: "id-1",
  displayName: "Yubikey",
  userAgent: "Mozilla/5.0 ... Chrome/124",
  enrolledAtMs: NOW - 7 * 24 * 3600 * 1000,
  lastUsedAtMs: null,
} as const;
const E2 = {
  id: "id-2",
  displayName: "MacBook touchID",
  userAgent: "Mozilla/5.0 ... Safari/17",
  enrolledAtMs: NOW - 1 * 24 * 3600 * 1000,
  lastUsedAtMs: NOW - 30 * 60 * 1000,
} as const;
const E3 = {
  id: "id-3",
  displayName: "iPhone biometric",
  userAgent: "Mozilla/5.0 ... iPhone OS 17",
  enrolledAtMs: NOW - 2 * 3600 * 1000,
  lastUsedAtMs: null,
} as const;

describe("emptyPasskeyRegistry", () => {
  it("returns version 1 with no entries", () => {
    const r = emptyPasskeyRegistry();
    expect(r.version).toBe(1);
    expect(r.entries).toEqual([]);
    expect(r.primaryId).toBeUndefined();
  });
});

describe("upsertCredential", () => {
  it("appends a new id", () => {
    const r = upsertCredential(emptyPasskeyRegistry(), E1);
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].id).toBe("id-1");
  });

  it("replaces an existing id in-place", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, { ...E1, displayName: "Renamed" });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].displayName).toBe("Renamed");
  });

  it("is idempotent under repeated identical calls", () => {
    const r1 = upsertCredential(emptyPasskeyRegistry(), E1);
    const r2 = upsertCredential(r1, E1);
    expect(r2.entries).toEqual(r1.entries);
  });
});

describe("removeCredential", () => {
  it("removes by id", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E2);
    r = removeCredential(r, "id-1");
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].id).toBe("id-2");
  });

  it("clears primaryId when primary device removed", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E2);
    r = setPrimaryCredential(r, "id-1");
    r = removeCredential(r, "id-1");
    expect(r.primaryId).toBeUndefined();
  });

  it("preserves primaryId when a non-primary device removed", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E2);
    r = setPrimaryCredential(r, "id-2");
    r = removeCredential(r, "id-1");
    expect(r.primaryId).toBe("id-2");
  });

  it("no-op for unknown id", () => {
    const r = upsertCredential(emptyPasskeyRegistry(), E1);
    const r2 = removeCredential(r, "missing");
    expect(r2.entries).toEqual(r.entries);
  });
});

describe("setPrimaryCredential", () => {
  it("marks an existing entry as primary", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E2);
    r = setPrimaryCredential(r, "id-1");
    expect(r.primaryId).toBe("id-1");
  });

  it("throws on unknown id", () => {
    const r = upsertCredential(emptyPasskeyRegistry(), E1);
    expect(() => setPrimaryCredential(r, "missing")).toThrow();
  });
});

describe("findPrimaryCredential", () => {
  it("returns null when registry is empty", () => {
    expect(findPrimaryCredential(emptyPasskeyRegistry())).toBeNull();
  });

  it("returns the explicit primary when set", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E2);
    r = setPrimaryCredential(r, "id-1");
    const primary = findPrimaryCredential(r);
    expect(primary?.id).toBe("id-1");
  });

  it("falls back to most-recently enrolled when primaryId not set", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E3);
    r = upsertCredential(r, E2);
    const primary = findPrimaryCredential(r);
    expect(primary?.id).toBe("id-3"); // E3 enrolledAtMs is most-recent
  });

  it("falls back to most-recent if primaryId points to removed entry", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E2);
    r = setPrimaryCredential(r, "id-1");
    r = removeCredential(r, "id-1"); // primaryId cleared by remove
    const primary = findPrimaryCredential(r);
    expect(primary?.id).toBe("id-2");
  });
});

describe("findCredentialById", () => {
  it("returns the entry when present", () => {
    const r = upsertCredential(emptyPasskeyRegistry(), E1);
    expect(findCredentialById(r, "id-1")?.id).toBe("id-1");
  });

  it("returns null when absent", () => {
    expect(findCredentialById(emptyPasskeyRegistry(), "id-x")).toBeNull();
  });
});

describe("orderForDisplay", () => {
  it("sorts most-recent enrolled first when primary unset", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E3);
    r = upsertCredential(r, E2);
    const ordered = orderForDisplay(r);
    expect(ordered.map((e) => e.id)).toEqual(["id-3", "id-2", "id-1"]);
  });

  it("hoists primary to the top, rest by recency", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E3);
    r = upsertCredential(r, E2);
    r = setPrimaryCredential(r, "id-1");
    const ordered = orderForDisplay(r);
    expect(ordered.map((e) => e.id)).toEqual(["id-1", "id-3", "id-2"]);
  });
});

describe("noteCredentialUsed", () => {
  it("updates lastUsedAtMs on the matching entry", () => {
    const r = upsertCredential(emptyPasskeyRegistry(), E1);
    const r2 = noteCredentialUsed(r, "id-1", NOW);
    expect(r2.entries[0].lastUsedAtMs).toBe(NOW);
  });

  it("no-op when id missing", () => {
    const r = upsertCredential(emptyPasskeyRegistry(), E1);
    const r2 = noteCredentialUsed(r, "missing", NOW);
    expect(r2.entries[0].lastUsedAtMs).toBeNull();
  });
});

describe("parsePasskeyRegistry — happy", () => {
  it("round-trips an empty registry", () => {
    const r = emptyPasskeyRegistry();
    const parsed = parsePasskeyRegistry(JSON.parse(JSON.stringify(r)));
    expect(parsed.ok).toBe(true);
  });

  it("parses a populated registry with primaryId", () => {
    let r = upsertCredential(emptyPasskeyRegistry(), E1);
    r = upsertCredential(r, E2);
    r = setPrimaryCredential(r, "id-1");
    const parsed = parsePasskeyRegistry(JSON.parse(JSON.stringify(r)));
    if (!parsed.ok) throw new Error();
    expect(parsed.registry.primaryId).toBe("id-1");
    expect(parsed.registry.entries.length).toBe(2);
  });
});

describe("parsePasskeyRegistry — rejection", () => {
  it("rejects null root", () => {
    const r = parsePasskeyRegistry(null);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_root_shape");
  });

  it("rejects array root", () => {
    const r = parsePasskeyRegistry([]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_root_shape");
  });

  it("rejects bad version", () => {
    const r = parsePasskeyRegistry({ version: 999, entries: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_version");
  });

  it("rejects bad entries field", () => {
    const r = parsePasskeyRegistry({ version: 1, entries: "nope" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_entries");
  });

  it("rejects malformed entry", () => {
    const r = parsePasskeyRegistry({
      version: 1,
      entries: [{ id: "x", displayName: "n", userAgent: "ua", enrolledAtMs: NaN, lastUsedAtMs: null }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_entry_shape");
  });

  it("rejects bad primaryId type", () => {
    const r = parsePasskeyRegistry({ version: 1, entries: [], primaryId: 42 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_primary_id");
  });
});
