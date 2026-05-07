import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  absoluteToTrackedPosix,
  resolveEffectiveSyncRoot,
  trackedLocalAbsolutePath,
  PathMappingError,
} from "../../src/core/pathMapping.js";

describe("pathMapping", () => {
  const ws = path.resolve("/workspace/proj");

  it("resolveEffectiveSyncRoot falls back to workspace root", () => {
    expect(resolveEffectiveSyncRoot(ws, undefined, "home").effectiveRoot).toBe(ws);
    expect(resolveEffectiveSyncRoot(ws, {}, "home").effectiveRoot).toBe(ws);
  });

  it("resolveEffectiveSyncRoot uses pathMapping[machineName]", () => {
    const sub = path.join(ws, "src", "app");
    const r = resolveEffectiveSyncRoot(ws, { dev: sub }, "dev").effectiveRoot;
    expect(r).toBe(path.resolve(sub));
  });

  it("throws when mapping points outside workspace", () => {
    expect(() =>
      resolveEffectiveSyncRoot(ws, { dev: path.resolve("/other/proj") }, "dev"),
    ).toThrow(PathMappingError);
  });

  it("trackedLocalAbsolutePath builds path under mapping", () => {
    const sub = path.join(ws, "sync-root");
    const abs = trackedLocalAbsolutePath(ws, { m: sub }, "m", "foo/bar.ts");
    expect(abs).toBe(path.join(sub, "foo", "bar.ts"));
  });

  it("absoluteToTrackedPosix inverts tracked root", () => {
    const sub = path.join(ws, "sync-root");
    const abs = path.join(sub, "x", "y.txt");
    expect(absoluteToTrackedPosix(ws, { m: sub }, "m", abs)).toBe("x/y.txt");
  });
});
