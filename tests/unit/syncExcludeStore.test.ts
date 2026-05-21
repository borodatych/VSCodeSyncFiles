import { describe, expect, it } from "vitest";
import {
  addExclusion,
  emptySyncExcludeFile,
  isExcluded,
  parseSyncExcludeFile,
  removeExclusion,
} from "../../src/core/syncExcludeStore.js";

describe("parseSyncExcludeFile", () => {
  it("ignores comments and blank lines", () => {
    const r = parseSyncExcludeFile("# header\n\nsrc/a.ts\n# comment\nsrc/b.ts\n");
    expect(r.entries).toEqual(["src/a.ts", "src/b.ts"]);
  });
  it("preserves original lines for round-trip writes", () => {
    const r = parseSyncExcludeFile("# header\nsrc/a.ts\n");
    expect(r.lines).toEqual(["# header", "src/a.ts", ""]);
  });
});

describe("isExcluded", () => {
  it("exact match", () => {
    const f = parseSyncExcludeFile("src/a.ts");
    expect(isExcluded(f, "src/a.ts")).toBe(true);
    expect(isExcluded(f, "src/b.ts")).toBe(false);
  });
  it("trailing-slash directory recursion", () => {
    const f = parseSyncExcludeFile("node_modules/");
    expect(isExcluded(f, "node_modules/foo/bar.js")).toBe(true);
    expect(isExcluded(f, "src/main.ts")).toBe(false);
  });
});

describe("addExclusion / removeExclusion", () => {
  it("idempotent add", () => {
    const f = parseSyncExcludeFile(emptySyncExcludeFile());
    const once = addExclusion(f, "src/a.ts");
    const twice = addExclusion(parseSyncExcludeFile(once), "src/a.ts");
    expect(twice).toBe(once);
  });
  it("remove drops just the matching line", () => {
    const initial = "src/a.ts\nsrc/b.ts\n";
    const f = parseSyncExcludeFile(initial);
    const after = removeExclusion(f, "src/a.ts");
    expect(after).not.toContain("src/a.ts\n");
    expect(after).toContain("src/b.ts");
  });
});

describe("emptySyncExcludeFile", () => {
  it("starts with a comment header", () => {
    expect(emptySyncExcludeFile().startsWith("# VSCodeSync")).toBe(true);
  });
});
