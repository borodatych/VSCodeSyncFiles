import { describe, expect, it } from "vitest";
import { planZipImport } from "../../src/core/zipImportPlanner.js";

describe("planZipImport", () => {
  it("rejects path traversal entries", () => {
    const r = planZipImport([{ path: "../escape.txt" }], "x.zip");
    expect(r.files).toEqual([]);
    expect(r.skipped[0]?.reason).toContain("unsafe-path");
  });

  it("rejects Windows-drive prefix (v0.17 A13)", () => {
    const r = planZipImport([{ path: "C:/Windows/system32/evil.exe" }], "x.zip");
    expect(r.files).toEqual([]);
    expect(r.skipped[0]?.reason).toContain("unsafe-path");
  });

  it("rejects lowercase drive letter too", () => {
    const r = planZipImport([{ path: "d:/secrets.txt" }], "x.zip");
    expect(r.files).toEqual([]);
  });

  it("strips leading slash from absolute paths", () => {
    const r = planZipImport([{ path: "/src/a.ts", bytes: 100 }], "x.zip");
    expect(r.files[0]?.posixRel).toBe("src/a.ts");
  });

  it("filters OS noise", () => {
    const r = planZipImport(
      [
        { path: "src/a.ts" },
        { path: "src/.DS_Store" },
        { path: "Thumbs.db" },
      ],
      "x.zip",
    );
    expect(r.files.map((f) => f.posixRel)).toEqual(["src/a.ts"]);
    expect(r.skipped.length).toBe(2);
  });

  it("skips vscodesync metadata", () => {
    const r = planZipImport([{ path: ".vscode/vscodesync.json" }], "x.zip");
    expect(r.files).toEqual([]);
    expect(r.skipped[0]?.reason).toContain("vscodesync-meta");
  });

  it("skips directory entries", () => {
    const r = planZipImport(
      [
        { path: "src/", isDirectory: true },
        { path: "src/a.ts" },
      ],
      "x.zip",
    );
    expect(r.files).toHaveLength(1);
  });

  it("derives workspaceNote from archive name", () => {
    const r = planZipImport([{ path: "x" }], "my_cool-project.zip");
    expect(r.workspaceNote).toBe("my cool project");
  });

  it("falls back to default when hint is empty", () => {
    const r = planZipImport([{ path: "x" }], "");
    expect(r.workspaceNote).toBe("Imported workspace");
  });

  it("accumulates totalBytes", () => {
    const r = planZipImport(
      [{ path: "a", bytes: 100 }, { path: "b", bytes: 200 }],
      "x",
    );
    expect(r.totalBytes).toBe(300);
  });

  it("converts Windows-style separators", () => {
    const r = planZipImport([{ path: "src\\sub\\a.ts" }], "x");
    expect(r.files[0]?.posixRel).toBe("src/sub/a.ts");
  });
});
