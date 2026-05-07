import { describe, expect, it } from "vitest";
import { newestTrackedLastSyncMs, hasArchivedTag } from "../../src/utils/workspaceLastActivity.js";
import type { WorkspaceConfig } from "../../src/core/types.js";

describe("workspaceLastActivity", () => {
  it("newestTrackedLastSyncMs returns max lastSync for workspace", () => {
    const t1 = "2020-01-01T00:00:00.000Z";
    const t2 = "2021-06-15T12:00:00.000Z";
    const wc: WorkspaceConfig = {
      activeWorkspaces: [],
      files: [
        {
          localPath: "a.txt",
          workspaceId: "w1",
          cloudPath: "a",
          lastSync: t1,
          localHash: "h",
        },
        {
          localPath: "b.txt",
          workspaceId: "w1",
          cloudPath: "b",
          lastSync: t2,
          localHash: "h",
        },
        {
          localPath: "c.txt",
          workspaceId: "w2",
          cloudPath: "c",
          lastSync: "2099-01-01T00:00:00.000Z",
          localHash: "h",
        },
      ],
    };
    expect(newestTrackedLastSyncMs(wc, "w1")).toBe(Date.parse(t2));
  });

  it("newestTrackedLastSyncMs returns undefined when no valid dates", () => {
    const wc: WorkspaceConfig = {
      activeWorkspaces: [],
      files: [
        {
          localPath: "a.txt",
          workspaceId: "w1",
          cloudPath: "a",
          lastSync: "",
          localHash: "h",
        },
      ],
    };
    expect(newestTrackedLastSyncMs(wc, "w1")).toBeUndefined();
  });

  it("hasArchivedTag is case-insensitive", () => {
    expect(hasArchivedTag(["Archived", "x"])).toBe(true);
    expect(hasArchivedTag(["other"])).toBe(false);
  });
});
