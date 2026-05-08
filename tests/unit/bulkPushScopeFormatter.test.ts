import { describe, expect, it } from "vitest";
import {
  formatBulkPushScopeRows,
  summariseBulkPushScope,
} from "../../src/core/bulkPushScopeFormatter.js";
import type { BulkPushTarget } from "../../src/core/bulkPushWizard.js";

function target(overrides: Partial<BulkPushTarget> = {}): BulkPushTarget {
  return {
    workspaceId: "ws-a",
    workspaceNote: "Workspace A",
    pendingFileCount: 5,
    ...overrides,
  };
}

describe("formatBulkPushScopeRows — labels and descriptions", () => {
  it("uses workspaceNote as the label", () => {
    const rows = formatBulkPushScopeRows([target({ workspaceNote: "Personal" })]);
    expect(rows[0].label).toBe("Personal");
  });

  it("falls back to workspaceId when note is empty", () => {
    const rows = formatBulkPushScopeRows([
      target({ workspaceId: "ws-fallback", workspaceNote: "" }),
    ]);
    expect(rows[0].label).toBe("ws-fallback");
  });

  it("formats default description with plural pending count", () => {
    expect(
      formatBulkPushScopeRows([target({ pendingFileCount: 5 })])[0].description,
    ).toBe("5 pending files");
    expect(
      formatBulkPushScopeRows([target({ pendingFileCount: 1 })])[0].description,
    ).toBe("1 pending file");
    expect(
      formatBulkPushScopeRows([target({ pendingFileCount: 0 })])[0].description,
    ).toBe("no pending changes");
  });

  it("respects a caller-supplied formatPendingCount", () => {
    const rows = formatBulkPushScopeRows([target({ pendingFileCount: 3 })], {
      formatPendingCount: (n) => `pending=${String(n)}`,
    });
    expect(rows[0].description).toBe("pending=3");
  });

  it("places the workspaceId in the detail row", () => {
    const rows = formatBulkPushScopeRows([target({ workspaceId: "ws-detail" })]);
    expect(rows[0].detail).toBe("id: ws-detail");
  });
});

describe("formatBulkPushScopeRows — preselection", () => {
  it("pre-selects targets with pendingFileCount > 0 by default", () => {
    const rows = formatBulkPushScopeRows([
      target({ workspaceId: "with", pendingFileCount: 5 }),
      target({ workspaceId: "without", pendingFileCount: 0 }),
    ]);
    expect(rows.find((r) => r.workspaceId === "with")?.picked).toBe(true);
    expect(rows.find((r) => r.workspaceId === "without")?.picked).toBe(false);
  });

  it("respects initiallyUncheckedIds for targets that would otherwise be selected", () => {
    const rows = formatBulkPushScopeRows(
      [target({ workspaceId: "with", pendingFileCount: 5 })],
      { initiallyUncheckedIds: ["with"] },
    );
    expect(rows[0].picked).toBe(false);
  });
});

describe("summariseBulkPushScope", () => {
  it("returns counts for selected workspaces and aggregate file count", () => {
    const targets = [
      target({ workspaceId: "a", pendingFileCount: 2 }),
      target({ workspaceId: "b", pendingFileCount: 3 }),
      target({ workspaceId: "c", pendingFileCount: 7 }),
    ];
    const summary = summariseBulkPushScope(targets, ["a", "c"]);
    expect(summary.selectedWorkspaceCount).toBe(2);
    expect(summary.totalSelectedFileCount).toBe(9);
    expect(summary.availableWorkspaceCount).toBe(3);
  });

  it("returns zero counts when no workspace ids selected", () => {
    const summary = summariseBulkPushScope([target()], []);
    expect(summary.selectedWorkspaceCount).toBe(0);
    expect(summary.totalSelectedFileCount).toBe(0);
  });

  it("ignores selected ids that don't appear in targets", () => {
    const summary = summariseBulkPushScope([target({ workspaceId: "a" })], ["b"]);
    expect(summary.selectedWorkspaceCount).toBe(0);
  });
});
