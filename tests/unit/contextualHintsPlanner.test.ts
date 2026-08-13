import { describe, expect, it } from "vitest";
import { planContextualHints, type ContextualHintsInput } from "../../src/core/contextualHintsPlanner.js";
import { isDivergedSyncStatus } from "../../src/core/types.js";

const base = (): ContextualHintsInput => ({
  conflictCount: 0,
  allWorkspacesFrozen: false,
  activeWorkspaceCount: 3,
  nowMs: 1_000_000_000,
});

describe("planContextualHints", () => {
  it("returns [] for healthy state", () => {
    expect(planContextualHints(base())).toEqual([]);
  });

  it("many_conflicts at threshold", () => {
    const hints = planContextualHints({ ...base(), conflictCount: 5 });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.id).toBe("many_conflicts");
    expect(hints[0]?.severity).toBe("warn");
  });

  it("files_missing_local предлагает привязку папки с порога", () => {
    const hints = planContextualHints({ ...base(), missingLocalCount: 3 });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.id).toBe("files_missing_local");
    expect(hints[0]?.severity).toBe("info");
    expect(hints[0]?.actionCommandId).toBe("vscodesync.bindLocalFolder");
  });

  it("ниже порога про отсутствующие файлы молчим", () => {
    expect(planContextualHints({ ...base(), missingLocalCount: 2 })).toHaveLength(0);
    expect(planContextualHints({ ...base() })).toHaveLength(0);
  });

  it("порог отсутствующих файлов настраивается", () => {
    const hints = planContextualHints(
      { ...base(), missingLocalCount: 1 },
      { missingLocalThreshold: 1 },
    );
    expect(hints.map((h) => h.id)).toEqual(["files_missing_local"]);
  });

  it("no many_conflicts below threshold", () => {
    expect(planContextualHints({ ...base(), conflictCount: 4 })).toHaveLength(0);
  });

  it("custom threshold", () => {
    const hints = planContextualHints(
      { ...base(), conflictCount: 3 },
      { manyConflictsThreshold: 2 },
    );
    expect(hints).toHaveLength(1);
  });

  it("all_workspaces_frozen only when activeCount > 0", () => {
    expect(planContextualHints({ ...base(), allWorkspacesFrozen: true, activeWorkspaceCount: 0 }))
      .toHaveLength(0);
    expect(planContextualHints({ ...base(), allWorkspacesFrozen: true, activeWorkspaceCount: 2 }))
      .toHaveLength(1);
  });

  it("quota_high triggers above ratio", () => {
    const hints = planContextualHints({ ...base(), quotaUsageRatio: 0.95 });
    expect(hints.map((h) => h.id)).toContain("quota_high");
    expect(hints.find((h) => h.id === "quota_high")?.text).toContain("95%");
  });

  it("auto_sync_paused_long after N days", () => {
    const day = 86_400_000;
    const hints = planContextualHints({
      ...base(),
      autoSyncOffSinceMs: 1_000_000_000 - 10 * day,
    });
    expect(hints.find((h) => h.id === "auto_sync_paused_long")).toBeDefined();
  });

  it("auto_sync_paused_long does not fire before N days", () => {
    const day = 86_400_000;
    expect(
      planContextualHints({
        ...base(),
        autoSyncOffSinceMs: 1_000_000_000 - 3 * day,
      }),
    ).toEqual([]);
  });

  it("multiple hints can fire together", () => {
    const hints = planContextualHints({
      ...base(),
      conflictCount: 10,
      quotaUsageRatio: 0.99,
    });
    expect(hints.map((h) => h.id).sort()).toEqual(["many_conflicts", "quota_high"]);
  });
});

describe("isDivergedSyncStatus", () => {
  it("ok и неизвестный статус расхождением не считаются", () => {
    expect(isDivergedSyncStatus("ok")).toBe(false);
    expect(isDivergedSyncStatus(undefined)).toBe(false);
  });

  it("всё, что требует действия, — расхождение", () => {
    for (const s of ["conflict", "pending_push", "cloud_newer", "missing_local"] as const) {
      expect(isDivergedSyncStatus(s)).toBe(true);
    }
  });
});
