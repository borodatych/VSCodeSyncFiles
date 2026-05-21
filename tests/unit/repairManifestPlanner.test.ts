import { describe, expect, it } from "vitest";
import {
  describeRepairPlan,
  planRepairManifest,
} from "../../src/core/repairManifestPlanner.js";

describe("planRepairManifest", () => {
  it("produces a valid-shape manifest from file paths + machines", () => {
    const p = planRepairManifest({
      workspaceId: "abcd1234",
      providerType: "onedrive",
      cloudFilePaths: ["src/a.ts", "src/b.ts"],
      machines: [{ machineId: "m1", machineName: "Work", lastSeen: "2026-05-21T00:00:00Z" }],
      nowIso: "2026-05-21T10:00:00.000Z",
      tagsHint: ["prod", " ", "infra"],
      gitBranchHint: "main",
    });
    expect(p.manifest.schemaVersion).toBe(1);
    expect(p.manifest.workspaceId).toBe("abcd1234");
    expect(p.manifest.files).toHaveLength(2);
    expect(p.manifest.machines).toHaveLength(1);
    expect(p.manifest.tags).toEqual(["prod", "infra"]);
    expect(p.manifest.gitBranch).toBe("main");
    expect(p.needsConfirmation).toBe(true);
  });

  it("workspaceNote falls back to id when hint is empty", () => {
    const p = planRepairManifest({
      workspaceId: "abcd1234",
      workspaceNoteHint: "   ",
      providerType: "gdrive",
      cloudFilePaths: [],
      machines: [],
    });
    expect(p.manifest.workspaceNote).toBe("abcd1234");
    expect(p.needsConfirmation).toBe(false);
  });

  it("strips empty file paths", () => {
    const p = planRepairManifest({
      workspaceId: "x",
      providerType: "yandex",
      cloudFilePaths: ["a.ts", "", "b.ts"],
      machines: [],
    });
    expect(p.manifest.files).toHaveLength(2);
  });

  it("describeRepairPlan returns a useful summary", () => {
    const p = planRepairManifest({
      workspaceId: "x",
      providerType: "dropbox",
      cloudFilePaths: ["a.ts"],
      machines: [],
    });
    const s = describeRepairPlan(p, "x");
    expect(s).toContain("1 файлов");
  });
});
