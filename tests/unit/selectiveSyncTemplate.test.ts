import { describe, expect, it } from "vitest";
import {
  renderSelectiveSyncIncludeTemplate,
  scoreSelectiveSyncImpact,
  summariseSelectiveSyncImpact,
} from "../../src/core/selectiveSyncTemplate.js";

describe("renderSelectiveSyncIncludeTemplate", () => {
  it("uses 'EXCLUDED' wording in exclude-list mode", () => {
    const t = renderSelectiveSyncIncludeTemplate("exclude-list");
    expect(t).toContain("EXCLUDED from sync");
  });

  it("uses 'only files matching' wording in include-list mode", () => {
    const t = renderSelectiveSyncIncludeTemplate("include-list");
    expect(t).toContain("only files matching one of these patterns sync");
  });

  it("explicitly notes that negation is unsupported", () => {
    const t = renderSelectiveSyncIncludeTemplate("include-list");
    expect(t).toContain("negation is NOT supported");
  });

  it("falls through to 'only files matching' for the all-tracked default", () => {
    const t = renderSelectiveSyncIncludeTemplate("all-tracked");
    expect(t).toContain("only files matching one of these patterns sync");
  });
});

describe("summariseSelectiveSyncImpact — flip detection", () => {
  it("detects files that would stop syncing when patterns shrink", () => {
    const r = summariseSelectiveSyncImpact({
      trackedRelPaths: ["src/a.ts", "src/b.ts", "docs/x.md"],
      prevMode: "include-list",
      prevPatterns: ["src/**", "docs/**"],
      nextMode: "include-list",
      nextPatterns: ["src/**"],
    });
    expect(r.wouldStop).toEqual(["docs/x.md"]);
    expect(r.wouldStart).toEqual([]);
    expect(r.unchangedCount).toBe(2);
  });

  it("detects files that would resume syncing when switching modes", () => {
    const r = summariseSelectiveSyncImpact({
      trackedRelPaths: ["src/a.ts", "secret.txt"],
      prevMode: "exclude-list",
      prevPatterns: ["secret.txt"],
      nextMode: "all-tracked",
      nextPatterns: [],
    });
    expect(r.wouldStart).toContain("secret.txt");
    expect(r.wouldStop).toEqual([]);
  });

  it("returns sorted output for deterministic UI rendering", () => {
    const r = summariseSelectiveSyncImpact({
      trackedRelPaths: ["z.ts", "a.ts", "m.ts"],
      prevMode: "all-tracked",
      prevPatterns: [],
      nextMode: "include-list",
      nextPatterns: [],
    });
    expect(r.wouldStop).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

describe("scoreSelectiveSyncImpact — severity ladder", () => {
  it("returns 'noop' when nothing flips", () => {
    expect(
      scoreSelectiveSyncImpact({ wouldStop: [], wouldStart: [], unchangedCount: 5 }),
    ).toBe("noop");
  });

  it("returns 'info' when only files start syncing (additive change)", () => {
    expect(
      scoreSelectiveSyncImpact({ wouldStop: [], wouldStart: ["a", "b"], unchangedCount: 3 }),
    ).toBe("info");
  });

  it("returns 'warn' for small data loss", () => {
    expect(
      scoreSelectiveSyncImpact({ wouldStop: ["a"], wouldStart: [], unchangedCount: 9 }),
    ).toBe("warn");
  });

  it("returns 'danger' when ≥ 10 files would stop syncing", () => {
    const wouldStop = Array.from({ length: 10 }, (_v, i) => `f${String(i)}`);
    expect(
      scoreSelectiveSyncImpact({ wouldStop, wouldStart: [], unchangedCount: 0 }),
    ).toBe("danger");
  });
});
