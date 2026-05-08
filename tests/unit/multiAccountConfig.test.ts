import { describe, expect, it } from "vitest";
import {
  addAccountSlot,
  DEFAULT_PRIMARY_SLOT_ID,
  isMultiAccountConfig,
  migrateToMultiAccountConfig,
  pickAccountSlot,
  removeAccountSlot,
  type AccountSlot,
  type MultiAccountConfig,
} from "../../src/core/multiAccountConfig.js";
import type { GlobalConfig } from "../../src/core/types.js";

function legacyConfig(): GlobalConfig {
  return {
    activeProvider: "onedrive",
    machineId: "m1",
    machineName: "host",
    onboardingCompleted: true,
    syncPaused: false,
    providers: {
      onedrive: { accountLabel: "Work", lastUsedIso: "2026-01-01T00:00:00Z" },
      gdrive: { accountLabel: "Personal" },
    },
  };
}

function multi(): MultiAccountConfig {
  return migrateToMultiAccountConfig(legacyConfig());
}

describe("migrateToMultiAccountConfig — schema", () => {
  it("creates one slot per legacy provider entry", () => {
    const c = migrateToMultiAccountConfig(legacyConfig());
    expect(isMultiAccountConfig(c)).toBe(true);
    expect(c.accounts.onedrive).toHaveLength(1);
    expect(c.accounts.onedrive?.[0].id).toBe(DEFAULT_PRIMARY_SLOT_ID);
    expect(c.accounts.onedrive?.[0].displayName).toBe("Work");
    expect(c.accounts.gdrive?.[0].displayName).toBe("Personal");
  });

  it("falls back to 'Primary' when accountLabel is missing", () => {
    const src: GlobalConfig = {
      ...legacyConfig(),
      providers: { yandex: {} },
    };
    const c = migrateToMultiAccountConfig(src);
    expect(c.accounts.yandex?.[0].displayName).toBe("Primary");
  });

  it("is idempotent on an already-migrated config", () => {
    const once = migrateToMultiAccountConfig(legacyConfig());
    const twice = migrateToMultiAccountConfig(once);
    expect(twice).toBe(once);
  });

  it("strips the legacy `providers` field after migration", () => {
    const c = migrateToMultiAccountConfig(legacyConfig());
    expect((c as unknown as { providers?: unknown }).providers).toBeUndefined();
  });
});

describe("addAccountSlot", () => {
  it("appends a new slot to an existing provider list", () => {
    const c = multi();
    const r = addAccountSlot(c, "onedrive", {
      id: "secondary",
      displayName: "Personal",
      metadata: { accountLabel: "Personal" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.accounts.onedrive).toHaveLength(2);
      expect(r.config.accounts.onedrive?.[1].id).toBe("secondary");
    }
  });

  it("rejects duplicate ids within the same provider", () => {
    const c = multi();
    const r = addAccountSlot(c, "onedrive", {
      id: DEFAULT_PRIMARY_SLOT_ID,
      displayName: "Dup",
      metadata: {},
    });
    expect(r).toEqual({ ok: false, reason: "duplicate_id" });
  });

  it("rejects empty id and empty display name", () => {
    const c = multi();
    const r1 = addAccountSlot(c, "yandex", { id: "", displayName: "x", metadata: {} });
    const r2 = addAccountSlot(c, "yandex", { id: "x", displayName: "", metadata: {} });
    expect(r1).toEqual({ ok: false, reason: "empty_id" });
    expect(r2).toEqual({ ok: false, reason: "empty_display_name" });
  });
});

describe("removeAccountSlot", () => {
  it("removes the slot and returns orphaned workspace ids", () => {
    const base = multi();
    const c: MultiAccountConfig = {
      ...base,
      workspaceAccount: {
        "ws-a": { providerType: "onedrive", slotId: DEFAULT_PRIMARY_SLOT_ID },
        "ws-b": { providerType: "onedrive", slotId: DEFAULT_PRIMARY_SLOT_ID },
        "ws-c": { providerType: "gdrive", slotId: DEFAULT_PRIMARY_SLOT_ID },
      },
    };
    // Add a second onedrive slot so removing primary won't be blocked by
    // the active-provider safety net.
    const added = addAccountSlot(c, "onedrive", {
      id: "secondary",
      displayName: "Personal",
      metadata: {},
    });
    if (!added.ok) throw new Error("add failed");
    const r = removeAccountSlot(added.config, "onedrive", DEFAULT_PRIMARY_SLOT_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.orphanedWorkspaceIds.sort()).toEqual(["ws-a", "ws-b"]);
      expect(r.config.workspaceAccount?.["ws-c"]).toEqual({
        providerType: "gdrive",
        slotId: DEFAULT_PRIMARY_SLOT_ID,
      });
      expect(r.config.accounts.onedrive).toHaveLength(1);
    }
  });

  it("refuses to delete the only slot of the active provider", () => {
    const c = multi();
    expect(removeAccountSlot(c, "onedrive", DEFAULT_PRIMARY_SLOT_ID)).toEqual({
      ok: false,
      reason: "would_orphan_active_provider",
    });
  });

  it("returns reason=unknown_slot for non-existent slot", () => {
    const c = multi();
    expect(removeAccountSlot(c, "gdrive", "unknown")).toEqual({
      ok: false,
      reason: "unknown_slot",
    });
  });
});

describe("pickAccountSlot", () => {
  it("returns the workspace-bound slot when binding exists", () => {
    const base = multi();
    const c = addAccountSlot(base, "onedrive", {
      id: "secondary",
      displayName: "Personal",
      metadata: {},
    });
    if (!c.ok) throw new Error("add failed");
    const withBinding: MultiAccountConfig = {
      ...c.config,
      workspaceAccount: {
        "ws-a": { providerType: "onedrive", slotId: "secondary" },
      },
    };
    const r = pickAccountSlot(withBinding, "onedrive", "ws-a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.slot.id).toBe("secondary");
  });

  it("falls back to the first slot when no binding exists", () => {
    const c = multi();
    const r = pickAccountSlot(c, "onedrive", "unbound-ws");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.slot.id).toBe(DEFAULT_PRIMARY_SLOT_ID);
  });

  it("returns reason=no_provider when the provider has no slots", () => {
    const c = multi();
    expect(pickAccountSlot(c, "dropbox", undefined)).toEqual({
      ok: false,
      reason: "no_provider",
    });
  });

  it("returns reason=unknown_slot when binding points to a deleted slot", () => {
    const c: MultiAccountConfig = {
      ...multi(),
      workspaceAccount: {
        "ws-a": { providerType: "onedrive", slotId: "missing" },
      },
    };
    const r = pickAccountSlot(c, "onedrive", "ws-a");
    expect(r).toEqual({ ok: false, reason: "unknown_slot" });
  });

  it("ignores binding that targets a different provider", () => {
    const c: MultiAccountConfig = {
      ...multi(),
      workspaceAccount: {
        "ws-a": { providerType: "yandex", slotId: "primary" },
      },
    };
    const r = pickAccountSlot(c, "onedrive", "ws-a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.slot.id).toBe(DEFAULT_PRIMARY_SLOT_ID);
  });
});

describe("isMultiAccountConfig — type guard", () => {
  it("returns false for legacy config", () => {
    expect(isMultiAccountConfig(legacyConfig())).toBe(false);
  });

  it("returns true for migrated config", () => {
    expect(isMultiAccountConfig(multi())).toBe(true);
  });
});

describe("addAccountSlot — leaves caller's slot untouched", () => {
  it("does not mutate the input slot or config object", () => {
    const c = multi();
    const slot: AccountSlot = {
      id: "x",
      displayName: "X",
      metadata: { accountLabel: "X" },
    };
    addAccountSlot(c, "yandex", slot);
    expect(c.accounts.yandex).toBeUndefined();
  });
});
