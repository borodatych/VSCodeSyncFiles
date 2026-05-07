import { describe, expect, it } from "vitest";
import {
  formatBulkPushResults,
  summariseBulkPushResults,
} from "../../src/core/bulkPushWizard.js";
import type { PushAllResult } from "../../src/core/syncEngine.js";

describe("summariseBulkPushResults", () => {
  it("counts ok / fail and totals pushed files", () => {
    const results: PushAllResult[] = [
      { workspaceId: "w1", ok: true, pushedFiles: 3 },
      { workspaceId: "w2", ok: true, pushedFiles: 0 },
      { workspaceId: "w3", ok: false, pushedFiles: 1, error: "boom" },
    ];
    const s = summariseBulkPushResults(results);
    expect(s.okCount).toBe(2);
    expect(s.failCount).toBe(1);
    expect(s.totalPushed).toBe(4);
    expect(s.failedWorkspaceIds).toEqual(["w3"]);
  });

  it("returns zeros for empty results", () => {
    const s = summariseBulkPushResults([]);
    expect(s.okCount).toBe(0);
    expect(s.failCount).toBe(0);
    expect(s.totalPushed).toBe(0);
  });
});

describe("formatBulkPushResults", () => {
  it("renders an all-ok header without a failures section", () => {
    const text = formatBulkPushResults([
      { workspaceId: "w1", ok: true, pushedFiles: 5 },
    ]);
    expect(text).toContain("1 ok / 0 failed");
    expect(text).toContain("Pushed 5 file(s)");
    expect(text).not.toContain("Failures:");
  });

  it("renders a failures section with workspace ids and error text", () => {
    const text = formatBulkPushResults([
      { workspaceId: "w1", ok: true, pushedFiles: 1 },
      { workspaceId: "w2", ok: false, pushedFiles: 0, error: "network down" },
    ]);
    expect(text).toContain("1 ok / 1 failed");
    expect(text).toContain("Failures:");
    expect(text).toContain("w2");
    expect(text).toContain("network down");
  });

  it("falls back to a placeholder when error message is missing", () => {
    const text = formatBulkPushResults([
      { workspaceId: "w1", ok: false, pushedFiles: 0 },
    ]);
    expect(text).toContain("(no error message)");
  });
});
