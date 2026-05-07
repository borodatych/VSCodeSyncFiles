/**
 * Tests for `buildCommitPrompt` — pure prompt construction (vscode-free).
 */
import { describe, it, expect } from "vitest";
import {
  MAX_FILES,
  MAX_PATH_LEN,
  buildCommitPrompt,
  truncatePath,
} from "../../src/core/aiCommitPrompt.js";

describe("truncatePath", () => {
  it("returns short paths unchanged", () => {
    expect(truncatePath("src/a.ts")).toBe("src/a.ts");
  });

  it("ellipsises long paths from the start", () => {
    const long = "a/".repeat(60) + "x.ts";
    const out = truncatePath(long, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("x.ts")).toBe(true);
  });

  it("respects custom max (output length stays ≤ max)", () => {
    const out = truncatePath("abcdefghij", 5);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("ghij")).toBe(true);
  });
});

describe("buildCommitPrompt", () => {
  it("includes workspace name", () => {
    const p = buildCommitPrompt({ workspaceNote: "frontend", changedFiles: ["a.ts"] });
    expect(p).toMatch(/frontend/);
  });

  it("falls back when workspace name is empty", () => {
    const p = buildCommitPrompt({ workspaceNote: "", changedFiles: ["a.ts"] });
    expect(p).toMatch(/\(unnamed\)/);
  });

  it("lists every file as a bullet", () => {
    const p = buildCommitPrompt({
      workspaceNote: "demo",
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    expect(p).toMatch(/- src\/a\.ts/);
    expect(p).toMatch(/- src\/b\.ts/);
    expect(p).toMatch(/- src\/c\.ts/);
  });

  it("truncates list to MAX_FILES", () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${String(i)}.ts`);
    const p = buildCommitPrompt({ workspaceNote: "demo", changedFiles: files });
    const matches = p.match(/^- /gm);
    expect(matches?.length ?? 0).toBe(MAX_FILES);
  });

  it("truncates very long file paths", () => {
    const long = "a/".repeat(50) + "deeply/nested/file.ts";
    const p = buildCommitPrompt({ workspaceNote: "demo", changedFiles: [long] });
    // Each file line stays within reasonable budget.
    const fileLines = p.split("\n").filter((l) => l.startsWith("- "));
    expect(fileLines[0].length).toBeLessThanOrEqual(MAX_PATH_LEN + 4);
  });

  it("hints conventional-commit format and types", () => {
    const p = buildCommitPrompt({ workspaceNote: "demo", changedFiles: ["a.ts"] });
    expect(p).toMatch(/Conventional-Commit/);
    expect(p).toMatch(/feat, fix, chore, refactor/);
  });

  it("intent: snapshot vs transfer changes the framing", () => {
    const a = buildCommitPrompt({
      workspaceNote: "demo",
      changedFiles: ["a.ts"],
      intent: "snapshot",
    });
    const b = buildCommitPrompt({
      workspaceNote: "demo",
      changedFiles: ["a.ts"],
      intent: "transfer",
    });
    expect(a).toMatch(/snapshot/);
    expect(b).toMatch(/transfer/);
    expect(a).not.toBe(b);
  });
});
