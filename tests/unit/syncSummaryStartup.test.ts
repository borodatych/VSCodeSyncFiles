import { describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../../src/core/types.js";
import { diffTrackedSnapshots } from "../../src/ui/syncSummaryDiff.js";

describe("syncSummaryStartup diffTrackedSnapshots", () => {
  it("находит добавление, удаление и обновление по хэшу", () => {
    const before: WorkspaceConfig = {
      activeWorkspaces: [{ workspaceId: "w1", workspaceNote: "WS", tags: [] }],
      files: [
        {
          localPath: "keep.txt",
          workspaceId: "w1",
          cloudPath: "c1",
          lastSync: "",
          localHash: "aaa",
          syncStatus: "ok",
        },
        {
          localPath: "gone.txt",
          workspaceId: "w1",
          cloudPath: "c2",
          lastSync: "",
          localHash: "bbb",
          syncStatus: "ok",
        },
      ],
    };
    const after: WorkspaceConfig = {
      activeWorkspaces: [{ workspaceId: "w1", workspaceNote: "WS", tags: [] }],
      files: [
        {
          localPath: "keep.txt",
          workspaceId: "w1",
          cloudPath: "c1",
          lastSync: "",
          localHash: "ccc",
          syncStatus: "ok",
        },
        {
          localPath: "new.txt",
          workspaceId: "w1",
          cloudPath: "c3",
          lastSync: "",
          localHash: "ddd",
          syncStatus: "ok",
        },
      ],
    };
    const root = "/proj";
    const d = diffTrackedSnapshots(before, after, root);
    expect(d.some((x) => x.kind === "updated" && x.localPath === "keep.txt")).toBe(true);
    expect(d.some((x) => x.kind === "removed" && x.localPath === "gone.txt")).toBe(true);
    expect(d.some((x) => x.kind === "added" && x.localPath === "new.txt")).toBe(true);
    expect(d.every((x) => x.folderRootFsPath === root)).toBe(true);
  });
});
