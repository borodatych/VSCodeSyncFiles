import { describe, expect, it } from "vitest";
import {
  classifyWorkspaceStructureImport,
  parseWorkspaceStructureImport,
  parseWorkspaceStructureLite,
} from "../../src/core/workspaceStructureImport.js";

describe("parseWorkspaceStructureLite", () => {
  it("parses schema 2 payload", () => {
    const l = parseWorkspaceStructureLite({
      schema: 2,
      sourceWorkspaceId: "a3f8c1d2",
      workspaceNote: "MyApp",
      files: ["src/a.ts", "b.ts"],
      exportedAt: "2026-01-01",
      exportedBy: "home",
    });
    expect(l.sourceWorkspaceId).toBe("a3f8c1d2");
    expect(l.files).toEqual(["src/a.ts", "b.ts"]);
  });

  it("dedupes paths", () => {
    const l = parseWorkspaceStructureLite({
      schema: 2,
      sourceWorkspaceId: "x",
      workspaceNote: "n",
      files: ["a.ts", "a.ts"],
      exportedAt: "",
      exportedBy: "",
    });
    expect(l.files).toEqual(["a.ts"]);
  });
});

describe("classifyWorkspaceStructureImport", () => {
  it("detects lite", () => {
    expect(
      classifyWorkspaceStructureImport({
        schema: 2,
        sourceWorkspaceId: "a",
        workspaceNote: "n",
        files: ["f.ts"],
        exportedAt: "",
        exportedBy: "",
      }),
    ).toBe("lite_portable");
  });
  it("detects full cache", () => {
    expect(
      classifyWorkspaceStructureImport({
        activeWorkspaces: [{ workspaceId: "a", workspaceNote: "n" }],
        files: [
          {
            localPath: "f.ts",
            workspaceId: "a",
            cloudPath: "VSCodeSyncFiles/a/f.ts",
            lastSync: "",
            localHash: "",
          },
        ],
      }),
    ).toBe("full_cache");
  });
});

describe("parseWorkspaceStructureImport", () => {
  it("rejects schema 2 in full parser", () => {
    expect(() =>
      parseWorkspaceStructureImport({
        schema: 2,
        sourceWorkspaceId: "a",
        workspaceNote: "n",
        files: ["f.ts"],
      }),
    ).toThrow(/портативная структура/);
  });

  it("accepts export-shaped JSON", () => {
    const c = parseWorkspaceStructureImport({
      schema: 1,
      exportedAt: "x",
      activeWorkspaces: [
        { workspaceId: "a1", workspaceNote: "N", manifestEtag: 'W/"1"' },
      ],
      files: [
        {
          localPath: "f.ts",
          workspaceId: "a1",
          cloudPath: "VSCodeSyncFiles/a1/f.ts",
          lastSync: "",
          localHash: "",
          syncStatus: "ok",
        },
      ],
    });
    expect(c.activeWorkspaces).toHaveLength(1);
    expect(c.files).toHaveLength(1);
    expect(c.files[0]?.localPath).toBe("f.ts");
  });

  it("rejects bad syncStatus", () => {
    expect(() =>
      parseWorkspaceStructureImport({
        activeWorkspaces: [{ workspaceId: "a", workspaceNote: "n" }],
        files: [
          {
            localPath: "f.ts",
            workspaceId: "a",
            cloudPath: "p",
            lastSync: "",
            localHash: "",
            syncStatus: "bogus",
          },
        ],
      }),
    ).not.toThrow();
    const c = parseWorkspaceStructureImport({
      activeWorkspaces: [{ workspaceId: "a", workspaceNote: "n" }],
      files: [
        {
          localPath: "f.ts",
          workspaceId: "a",
          cloudPath: "p",
          lastSync: "",
          localHash: "",
          syncStatus: "bogus",
        },
      ],
    });
    expect(c.files[0]?.syncStatus).toBeUndefined();
  });
});
