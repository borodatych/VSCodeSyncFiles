import { describe, expect, it } from "vitest";
import { workspaceHealthFromLocalCfg } from "../../src/ui/workspaceHealthLocal.js";
import type { WorkspaceConfig } from "../../src/core/types.js";

describe("workspaceHealthFromLocalCfg", () => {
  const base = (files: WorkspaceConfig["files"]): WorkspaceConfig => ({
    activeWorkspaces: [{ workspaceId: "w1", workspaceNote: "N" }],
    files,
  });

  it("red when any conflict", () => {
    const wc = base([
      {
        localPath: "a.ts",
        workspaceId: "w1",
        cloudPath: "p",
        lastSync: new Date().toISOString(),
        localHash: "h",
        syncStatus: "conflict",
      },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("red");
    expect(workspaceHealthFromLocalCfg(wc, "w1").summaryLines[0]).toContain("a.ts");
  });

  it("green when recent sync and no files edge", () => {
    const wc = base([]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("green");
  });

  it("green when last sync < 24h", () => {
    const t = new Date(Date.now() - 3 * 3600_000).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("green");
  });

  it("yellow when last sync >= 24h and <= 7d", () => {
    const t = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("yellow");
  });

  it("red when last sync > 7d", () => {
    const t = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("red");
  });

  it("yellow when lastSync invalid", () => {
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: "", localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("yellow");
  });

  it("yellow when file has active soft lock from another machine", () => {
    const t = new Date(Date.now() - 1 * 3600_000).toISOString();
    const wc = base([
      {
        localPath: "locked.ts",
        workspaceId: "w1",
        cloudPath: "p",
        lastSync: t,
        localHash: "h",
        editingBy: "other-machine-id",
        editingByName: "work",
      },
    ]);
    const result = workspaceHealthFromLocalCfg(wc, "w1");
    expect(result.level).toBe("yellow");
    expect(result.summaryLines[0]).toContain("locked.ts");
    expect(result.summaryLines[0]).toContain("work");
  });
});
