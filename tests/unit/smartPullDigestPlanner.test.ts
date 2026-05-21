import { describe, expect, it } from "vitest";
import {
  buildSmartPullDigest,
  type DigestInputFile,
} from "../../src/core/smartPullDigestPlanner.js";

describe("smartPullDigestPlanner — F1", () => {
  const f = (path: string, status?: string, editingByName?: string, ws = "alpha-workspace"): DigestInputFile => ({
    workspaceId: "w1",
    workspaceNote: ws,
    localPath: path,
    syncStatus: status,
    editingByName,
  });

  it("empty digest when nothing cloud_newer", () => {
    const d = buildSmartPullDigest([f("a.ts"), f("b.ts")]);
    expect(d.totalCloudNewer).toBe(0);
    expect(d.totalConflicts).toBe(0);
    expect(d.headline).toMatch(/ничего нового/);
  });

  it("groups by editingByName when known", () => {
    const d = buildSmartPullDigest([
      f("a.ts", "cloud_newer", "work-laptop"),
      f("b.ts", "cloud_newer", "work-laptop"),
      f("c.ts", "cloud_newer", "home-desktop"),
    ]);
    expect(d.totalCloudNewer).toBe(3);
    expect(d.groups).toHaveLength(2);
    expect(d.groups[0]).toMatchObject({
      kind: "machine",
      groupLabel: "work-laptop",
    });
    expect(d.groups[0]?.files ?? []).toHaveLength(2);
  });

  it("falls back to workspace grouping when no editingByName", () => {
    const d = buildSmartPullDigest([
      f("a.ts", "cloud_newer", undefined, "alpha-workspace"),
      f("b.ts", "cloud_newer", undefined, "alpha-workspace"),
      f("c.ts", "cloud_newer", undefined, "beta-workspace"),
    ]);
    expect(d.groups[0]).toMatchObject({
      kind: "workspace",
      groupLabel: "alpha-workspace",
    });
  });

  it("conflicts counted separately", () => {
    const d = buildSmartPullDigest([
      f("a.ts", "cloud_newer", "machine-b"),
      f("b.ts", "conflict"),
      f("c.ts", "conflict"),
    ]);
    expect(d.totalCloudNewer).toBe(1);
    expect(d.totalConflicts).toBe(2);
    expect(d.headline).toMatch(/2 конфликт/);
    expect(d.markdown).toMatch(/⚠ Конфликты/);
  });

  it("caps per-group list at 5 with overflow note", () => {
    const files = Array.from({ length: 9 }, (_, i) =>
      f(`f${String(i)}.ts`, "cloud_newer", "machine-b"),
    );
    const d = buildSmartPullDigest(files);
    expect(d.markdown).toMatch(/… ещё 4/);
  });
});
