import { describe, expect, it } from "vitest";
import {
  buildQuickSwitchItems,
  renderSparkline,
  type QuickSwitchWorkspace,
} from "../../src/core/quickSwitchScorer.js";

const ws = (
  workspaceId: string,
  partial: Partial<QuickSwitchWorkspace> = {},
): QuickSwitchWorkspace => ({
  workspaceId,
  workspaceNote: workspaceId,
  lastSyncMs: 0,
  fileCount: 0,
  state: "active",
  ...partial,
});

describe("renderSparkline", () => {
  it("empty input → empty string", () => {
    expect(renderSparkline(undefined)).toBe("");
    expect(renderSparkline([])).toBe("");
  });

  it("all zeros → all-space blocks of correct length", () => {
    const out = renderSparkline([0, 0, 0, 0]);
    expect(out).toHaveLength(4);
    expect(out).toBe("    ");
  });

  it("max maps to full block", () => {
    const out = renderSparkline([0, 10]);
    expect(out[1]).toBe("█");
  });

  it("preserves order", () => {
    const out = renderSparkline([1, 5, 10]);
    expect(out.length).toBe(3);
  });
});

describe("buildQuickSwitchItems", () => {
  it("pinned rises to the top", () => {
    const items = buildQuickSwitchItems(
      [ws("a"), ws("pinned", { lastSyncMs: 0 }), ws("c", { lastSyncMs: Date.now() })],
      { pinned: new Set(["pinned"]) },
    );
    expect(items[0]?.workspaceId).toBe("pinned");
    expect(items[0]?.label.startsWith("★ ")).toBe(true);
  });

  it("recently synced active > old active", () => {
    const now = Date.now();
    const items = buildQuickSwitchItems(
      [
        ws("old", { lastSyncMs: now - 60 * 86_400_000 }),
        ws("fresh", { lastSyncMs: now - 1000 }),
      ],
      { nowMs: now },
    );
    expect(items[0]?.workspaceId).toBe("fresh");
  });

  it("active > suspended > frozen > archived", () => {
    const now = Date.now();
    const items = buildQuickSwitchItems(
      [
        ws("arch", { state: "archived" }),
        ws("frozen", { state: "frozen" }),
        ws("active", { state: "active" }),
        ws("susp", { state: "suspended" }),
      ],
      { nowMs: now },
    );
    expect(items.map((i) => i.workspaceId)).toEqual(["active", "susp", "frozen", "arch"]);
  });

  it("filter matches note + tags + id", () => {
    const items = buildQuickSwitchItems(
      [
        ws("a", { workspaceNote: "production server", tags: ["infra"] }),
        ws("b", { workspaceNote: "personal", tags: ["dev"] }),
      ],
      { filter: "infra" },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.workspaceId).toBe("a");
  });

  it("returns sparkline when hourlyCounts provided", () => {
    const items = buildQuickSwitchItems(
      [ws("x", { hourlyCounts: [0, 1, 2, 5, 1, 0] })],
    );
    expect(items[0]?.sparkline.length).toBe(6);
  });

  it("formats lastSyncMs into human-readable detail", () => {
    const now = Date.now();
    const items = buildQuickSwitchItems(
      [ws("just", { lastSyncMs: now - 60_000 })],
      { nowMs: now },
    );
    expect(items[0]?.detail).toContain("только что");
  });
});
