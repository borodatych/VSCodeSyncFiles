import { describe, expect, it } from "vitest";
import {
  buildSbomReport,
  formatSbomMarkdown,
} from "../../src/core/sbomReport.js";

describe("buildSbomReport", () => {
  it("aggregates totals correctly", () => {
    const r = buildSbomReport({
      workspaces: [
        {
          workspaceId: "ws1",
          workspaceNote: "Project A",
          files: [
            { posixRel: "src/a.ts", bytes: 1024, machineIds: ["m1"] },
            { posixRel: "src/b.ts", bytes: 2048, machineIds: ["m1", "m2"] },
          ],
        },
        {
          workspaceId: "ws2",
          workspaceNote: "Project B",
          files: [{ posixRel: "x.md", bytes: 512, machineIds: ["m2"] }],
        },
      ],
    });
    expect(r.workspaceCount).toBe(2);
    expect(r.fileCount).toBe(3);
    expect(r.totalBytes).toBe(3584);
  });

  it("sorts files by bytes desc", () => {
    const r = buildSbomReport({
      workspaces: [{
        workspaceId: "w", workspaceNote: "w", files: [
          { posixRel: "small", bytes: 10, machineIds: [] },
          { posixRel: "big", bytes: 1000, machineIds: [] },
        ],
      }],
    });
    expect(r.files[0]?.posixRel).toBe("big");
  });

  it("byWorkspace sorted by bytes desc", () => {
    const r = buildSbomReport({
      workspaces: [
        { workspaceId: "a", workspaceNote: "a", files: [{ posixRel: "x", bytes: 100, machineIds: [] }] },
        { workspaceId: "b", workspaceNote: "b", files: [{ posixRel: "y", bytes: 1000, machineIds: [] }] },
      ],
    });
    expect(r.byWorkspace[0]?.workspaceId).toBe("b");
  });

  it("dedupes machine ids", () => {
    const r = buildSbomReport({
      workspaces: [{
        workspaceId: "a", workspaceNote: "a", files: [{
          posixRel: "x", bytes: 1, machineIds: ["m1", "m1", "m2"],
        }],
      }],
    });
    expect(r.files[0]?.machineIds.sort()).toEqual(["m1", "m2"]);
  });

  it("markdown contains all sections", () => {
    const r = buildSbomReport({
      workspaces: [{ workspaceId: "w", workspaceNote: "test", files: [{ posixRel: "x", bytes: 1, machineIds: [] }] }],
    });
    const md = formatSbomMarkdown(r);
    expect(md).toContain("SBOM report");
    expect(md).toContain("By workspace");
    expect(md).toContain("Top 50 heaviest");
  });
});
