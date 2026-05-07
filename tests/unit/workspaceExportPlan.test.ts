import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  escapingPaths,
  planWorkspaceExport,
} from "../../src/core/workspaceExportPlan.js";
import type { CloudManifest } from "../../src/core/cloudLayout.js";

function manifest(files: { path: string; removedAt?: string }[]): CloudManifest {
  return {
    schemaVersion: 1,
    workspaceId: "ws-1",
    workspaceNote: "test",
    tags: [],
    providerType: "onedrive",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    machines: [],
    files: files.map((f) => ({
      path: f.path,
      addedAt: "2026-05-01T00:00:00Z",
      version: 1,
      hasSyncignoreMarkers: false,
      removedAt: f.removedAt,
    })),
  };
}

describe("planWorkspaceExport", () => {
  it("filters tombstoned files", () => {
    const r = planWorkspaceExport(
      manifest([
        { path: "src/a.ts" },
        { path: "src/b.ts", removedAt: "2026-05-01T00:00:00Z" },
      ]),
      "C:/Out",
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.posixRel).toBe("src/a.ts");
    expect(r.empty).toBe(false);
  });
  it("composes target with OS-correct separators", () => {
    const r = planWorkspaceExport(manifest([{ path: "foo/bar.ts" }]), "D:/Out");
    expect(r.entries[0]?.targetAbs).toBe(path.join("D:/Out", "foo", "bar.ts"));
  });
  it("flags empty manifest", () => {
    const r = planWorkspaceExport(manifest([]), "C:/Out");
    expect(r.empty).toBe(true);
  });
  it("strips dot-dot segments", () => {
    const r = planWorkspaceExport(manifest([{ path: "../a.ts" }]), "C:/Out");
    expect(r.entries[0]?.targetAbs).toBe(path.join("C:/Out", "a.ts"));
  });
});

describe("escapingPaths", () => {
  it("returns nothing for normal entries", () => {
    const plan = planWorkspaceExport(manifest([{ path: "src/a.ts" }]), "C:/Out");
    expect(escapingPaths(plan)).toEqual([]);
  });
});
