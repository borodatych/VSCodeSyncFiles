import { describe, expect, it } from "vitest";
import { planKeepBothResolution } from "../../src/core/keepBothConflictResolver.js";

describe("planKeepBothResolution", () => {
  it("inserts the suffix before the extension", () => {
    const p = planKeepBothResolution({
      posixRel: "src/foo.ts",
      remoteMachineLabel: "work-laptop",
      nowIso: "2026-05-21T10:00:00.000Z",
    });
    expect(p.localRel).toBe("src/foo.ts");
    expect(p.theirsRel).toBe("src/foo.conflict-work-laptop-2026-05-21T10-00-00-000Z.ts");
    expect(p.backupFolderName).toBe("conflict-2026-05-21T10-00-00-000Z");
  });

  it("handles files without extension", () => {
    const p = planKeepBothResolution({
      posixRel: "Makefile",
      remoteMachineLabel: "ws",
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(p.theirsRel).toBe("Makefile.conflict-ws-2026-01-01T00-00-00-000Z");
  });

  it("hidden files (.gitignore) keep no extension", () => {
    const p = planKeepBothResolution({
      posixRel: ".gitignore",
      remoteMachineLabel: "ws",
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(p.theirsRel).toBe(".gitignore.conflict-ws-2026-01-01T00-00-00-000Z");
  });

  it("multi-dot files split on the last dot only", () => {
    const p = planKeepBothResolution({
      posixRel: "lib/types.d.ts",
      remoteMachineLabel: "ws",
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(p.theirsRel).toBe("lib/types.d.conflict-ws-2026-01-01T00-00-00-000Z.ts");
  });

  it("trailing dot files (`file.`) treat the dot as not an extension", () => {
    const p = planKeepBothResolution({
      posixRel: "weird.",
      remoteMachineLabel: "ws",
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(p.theirsRel).toBe("weird..conflict-ws-2026-01-01T00-00-00-000Z");
  });

  it("sanitises unsafe characters in machine label", () => {
    const p = planKeepBothResolution({
      posixRel: "a.ts",
      remoteMachineLabel: "DESKTOP/x:y*<>|",
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(p.theirsRel).toContain("conflict-DESKTOP-x-y");
    expect(p.theirsRel).not.toMatch(/[/:*<>|]/);
  });

  it("preserves nested directories", () => {
    const p = planKeepBothResolution({
      posixRel: "a/b/c/x.json",
      remoteMachineLabel: "ws",
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(p.theirsRel.startsWith("a/b/c/x.conflict-")).toBe(true);
    expect(p.theirsRel.endsWith(".json")).toBe(true);
  });
});
