import { describe, expect, it } from "vitest";
import { formatAccountSlotPicker } from "../../src/core/multiAccountPickerFormatter.js";
import {
  addAccountSlot,
  migrateToMultiAccountConfig,
  type MultiAccountConfig,
} from "../../src/core/multiAccountConfig.js";
import type { GlobalConfig } from "../../src/core/types.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

function makeConfig(): MultiAccountConfig {
  const legacy: GlobalConfig = {
    activeProvider: "onedrive",
    machineId: "m1",
    machineName: "host",
    onboardingCompleted: true,
    syncPaused: false,
    providers: {
      onedrive: { accountLabel: "Work", lastUsedIso: new Date(NOW - 2 * DAY).toISOString() },
    },
  };
  let c = migrateToMultiAccountConfig(legacy);
  const r = addAccountSlot(c, "onedrive", {
    id: "personal",
    displayName: "Personal",
    metadata: { accountLabel: "Personal", lastUsedIso: new Date(NOW - 30 * 60_000).toISOString() },
  });
  if (!r.ok) throw new Error("addAccountSlot failed");
  c = r.config;
  return c;
}

describe("formatAccountSlotPicker — rows", () => {
  it("emits one row per slot with label/description/detail/picked", () => {
    const c = makeConfig();
    const rows = formatAccountSlotPicker(c, "onedrive", { nowMs: NOW });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.slotId).sort()).toEqual(["personal", "primary"]);
  });

  it("returns empty array for a provider with no slots", () => {
    const c = makeConfig();
    const rows = formatAccountSlotPicker(c, "yandex", { nowMs: NOW });
    expect(rows).toEqual([]);
  });
});

describe("formatAccountSlotPicker — pre-selection", () => {
  it("pre-selects the workspace-bound slot when binding exists", () => {
    const c = makeConfig();
    const withBinding: MultiAccountConfig = {
      ...c,
      workspaceAccount: {
        "ws-a": { providerType: "onedrive", slotId: "personal" },
      },
    };
    const rows = formatAccountSlotPicker(withBinding, "onedrive", {
      currentWorkspaceId: "ws-a",
      nowMs: NOW,
    });
    expect(rows[0].slotId).toBe("personal");
    expect(rows[0].picked).toBe(true);
    expect(rows[1].picked).toBe(false);
  });

  it("falls back to first slot when no workspaceId supplied", () => {
    const c = makeConfig();
    const rows = formatAccountSlotPicker(c, "onedrive", { nowMs: NOW });
    expect(rows[0].picked).toBe(true);
    expect(rows[0].slotId).toBe("primary"); // primary was the migrated slot, listed first
  });

  it("falls back to first slot when binding points to a different provider", () => {
    const c = makeConfig();
    const withMismatchedBinding: MultiAccountConfig = {
      ...c,
      workspaceAccount: {
        "ws-a": { providerType: "yandex", slotId: "primary" },
      },
    };
    const rows = formatAccountSlotPicker(withMismatchedBinding, "onedrive", {
      currentWorkspaceId: "ws-a",
      nowMs: NOW,
    });
    expect(rows[0].picked).toBe(true);
  });
});

describe("formatAccountSlotPicker — descriptions", () => {
  it("annotates the bound row with '(current)' suffix", () => {
    const c = makeConfig();
    const rows = formatAccountSlotPicker(c, "onedrive", { nowMs: NOW });
    expect(rows[0].description).toContain("(current)");
    expect(rows[1].description).not.toContain("(current)");
  });

  it("emits 'Never used' when lastUsedIso is missing", () => {
    const c = makeConfig();
    const cWithUnused = addAccountSlot(c, "yandex", {
      id: "primary",
      displayName: "Y",
      metadata: { accountLabel: "Y" },
    });
    if (!cWithUnused.ok) throw new Error("addAccountSlot failed");
    const rows = formatAccountSlotPicker(cWithUnused.config, "yandex", { nowMs: NOW });
    expect(rows[0].detail).toBe("Never used");
  });

  it("emits 'Last used X minutes ago' for sub-hour ages", () => {
    const c = makeConfig();
    const rows = formatAccountSlotPicker(c, "onedrive", { nowMs: NOW });
    const personal = rows.find((r) => r.slotId === "personal");
    expect(personal?.detail).toContain("minute");
  });

  it("emits 'Last used N days ago' for day-scale ages", () => {
    const c = makeConfig();
    const rows = formatAccountSlotPicker(c, "onedrive", { nowMs: NOW });
    const primary = rows.find((r) => r.slotId === "primary");
    expect(primary?.detail).toContain("2 days");
  });

  it("respects a caller-supplied formatLastUsed", () => {
    const c = makeConfig();
    const rows = formatAccountSlotPicker(c, "onedrive", {
      nowMs: NOW,
      formatLastUsed: (iso) => `iso=${iso ?? "none"}`,
    });
    expect(rows[0].detail).toContain("iso=");
  });
});

describe("formatAccountSlotPicker — bound row sort", () => {
  it("places the bound slot first regardless of insertion order", () => {
    const c = makeConfig();
    const withBinding: MultiAccountConfig = {
      ...c,
      workspaceAccount: {
        "ws-a": { providerType: "onedrive", slotId: "personal" },
      },
    };
    const rows = formatAccountSlotPicker(withBinding, "onedrive", {
      currentWorkspaceId: "ws-a",
    });
    expect(rows[0].slotId).toBe("personal");
  });
});
