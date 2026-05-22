import { describe, expect, it } from "vitest";
import { workspaceHealthFromLocalCfg } from "../../src/ui/workspaceHealthLocal.js";
import type { WorkspaceConfig } from "../../src/core/types.js";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

describe("workspaceHealthFromLocalCfg (7-level palette)", () => {
  const base = (files: WorkspaceConfig["files"]): WorkspaceConfig => ({
    activeWorkspaces: [{ workspaceId: "w1", workspaceNote: "N" }],
    files,
  });

  it("conflict when any file has syncStatus === conflict", () => {
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
    const r = workspaceHealthFromLocalCfg(wc, "w1");
    expect(r.level).toBe("conflict");
    expect(r.summaryLines[0]).toContain("a.ts");
  });

  it("editing when another machine holds soft-lock", () => {
    const t = new Date(Date.now() - HOUR_MS).toISOString();
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
    const r = workspaceHealthFromLocalCfg(wc, "w1");
    expect(r.level).toBe("editing");
    expect(r.summaryLines[0]).toContain("locked.ts");
    expect(r.summaryLines[0]).toContain("work");
  });

  it("noData when workspace has no tracked files", () => {
    const r = workspaceHealthFromLocalCfg(base([]), "w1");
    expect(r.level).toBe("noData");
    expect(r.summaryLines[0]).toContain("Нет отслеживаемых");
  });

  it("noData when lastSync is invalid for every file", () => {
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: "", localHash: "h" },
    ]);
    const r = workspaceHealthFromLocalCfg(wc, "w1");
    expect(r.level).toBe("noData");
    expect(r.summaryLines[0]).toContain("lastSync");
  });

  it("fresh when max(lastSync) is under 12 h", () => {
    const t = new Date(Date.now() - 3 * HOUR_MS).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("fresh");
  });

  it("fresh just under the 12 h boundary", () => {
    const t = new Date(Date.now() - (12 * HOUR_MS - 60_000)).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("fresh");
  });

  it("recent when 12 h ≤ max(lastSync) < 48 h", () => {
    const t = new Date(Date.now() - 24 * HOUR_MS).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("recent");
  });

  it("recent at the 12 h boundary (inclusive)", () => {
    const t = new Date(Date.now() - 12 * HOUR_MS).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("recent");
  });

  it("staleOk when 48 h ≤ max(lastSync) ≤ 14 d", () => {
    const t = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("staleOk");
  });

  it("staleOk at the 48 h boundary (inclusive)", () => {
    const t = new Date(Date.now() - 48 * HOUR_MS).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("staleOk");
  });

  it("staleDeep when max(lastSync) > 14 d", () => {
    const t = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("staleDeep");
  });

  it("staleDeep at the 14 d boundary (inclusive)", () => {
    const t = new Date(Date.now() - 14 * DAY_MS).toISOString();
    const wc = base([
      { localPath: "x.ts", workspaceId: "w1", cloudPath: "p", lastSync: t, localHash: "h" },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("staleDeep");
  });

  it("conflict beats every other category", () => {
    const t = new Date(Date.now() - HOUR_MS).toISOString();
    const wc = base([
      {
        localPath: "a.ts",
        workspaceId: "w1",
        cloudPath: "p",
        lastSync: t,
        localHash: "h",
        syncStatus: "conflict",
        editingBy: "other",
      },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("conflict");
  });

  it("editing beats noData and stale shades when no conflict", () => {
    const t = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const wc = base([
      {
        localPath: "a.ts",
        workspaceId: "w1",
        cloudPath: "p",
        lastSync: t,
        localHash: "h",
        editingBy: "other",
      },
    ]);
    expect(workspaceHealthFromLocalCfg(wc, "w1").level).toBe("editing");
  });
});
