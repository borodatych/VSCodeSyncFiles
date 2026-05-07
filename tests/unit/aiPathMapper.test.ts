import { describe, it, expect } from "vitest";
import {
  applyRemapEdits,
  buildPathMapperPrompt,
  findSuspiciousPaths,
  parseRemapEdits,
} from "../../src/core/aiPathMapper.js";

describe("findSuspiciousPaths", () => {
  it("flags POSIX home outside newRoot", () => {
    const r = findSuspiciousPaths({
      oldRoot: "/home/alice/Projects/myapp",
      newRoot: "D:/Projects/myapp",
      configs: {
        ".vscode/launch.json": `{
  "program": "/home/alice/Projects/myapp/dist/index.js",
  "cwd": "/home/alice/Projects/myapp"
}`,
      },
    });
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r[0]?.configPath).toBe(".vscode/launch.json");
  });
  it("flags Windows drive paths", () => {
    const r = findSuspiciousPaths({
      oldRoot: "C:/Old/myapp",
      newRoot: "D:/Projects/myapp",
      configs: { "tasks.json": '{"command": "C:\\\\Old\\\\myapp\\\\tools\\\\build.exe"}' },
    });
    expect(r.length).toBeGreaterThan(0);
  });
  it("skips paths already inside newRoot", () => {
    const r = findSuspiciousPaths({
      oldRoot: "/home/alice/x",
      newRoot: "D:/Projects/myapp",
      configs: { "a.json": '{"path": "D:/Projects/myapp/dist/x.js"}' },
    });
    expect(r).toHaveLength(0);
  });
  it("skips oversized configs", () => {
    const big = "a".repeat(20_000) + " /home/alice/x ";
    const r = findSuspiciousPaths({
      oldRoot: "/home/alice/x",
      newRoot: "D:/Projects/myapp",
      configs: { "huge.json": big },
    });
    expect(r).toHaveLength(0);
  });
});

describe("buildPathMapperPrompt", () => {
  it("includes old/new roots and listed paths", () => {
    const p = buildPathMapperPrompt(
      { oldRoot: "/old", newRoot: "/new", configs: {} },
      [{ configPath: "a.json", line: 3, match: "/old/foo" }],
    );
    expect(p).toMatch(/Old root: \/old/);
    expect(p).toMatch(/New root: \/new/);
    expect(p).toMatch(/a\.json:3 → \/old\/foo/);
  });
});

describe("parseRemapEdits", () => {
  it("parses fenced JSON", () => {
    const r = parseRemapEdits('```json\n[{"configPath":"a","find":"/old","replace":"/new"}]\n```');
    expect(r).toEqual([{ configPath: "a", find: "/old", replace: "/new" }]);
  });
  it("filters bad shapes", () => {
    const r = parseRemapEdits('[{"configPath":"a"},{"configPath":"b","find":"","replace":"x"}]');
    expect(r).toHaveLength(0);
  });
  it("returns [] on non-JSON", () => {
    expect(parseRemapEdits("nope")).toEqual([]);
  });
});

describe("applyRemapEdits", () => {
  it("does literal replacement", () => {
    const out = applyRemapEdits('{"x":"/old/a","y":"/old/a"}', [
      { configPath: "x", find: "/old", replace: "/new" },
    ]);
    expect(out).toBe('{"x":"/new/a","y":"/new/a"}');
  });
});
