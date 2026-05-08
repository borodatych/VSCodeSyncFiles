import { describe, expect, it } from "vitest";
import {
  planGitImport,
  renderVscodesyncIgnore,
} from "../../src/core/gitImportPlanner.js";
import {
  compareGitBranches,
  describeBranchVerdict,
  parseGitHead,
} from "../../src/core/gitHeadCompare.js";

describe("planGitImport", () => {
  it("imports plain patterns and strips root anchors", () => {
    const r = planGitImport("/node_modules\nbuild/\n*.log\n");
    expect(r.patterns).toEqual(["node_modules", "build/", "*.log"]);
    expect(r.unsupportedNegations).toEqual([]);
  });

  it("collects comments separately and preserves them", () => {
    const r = planGitImport("# a comment\nfoo\n# another\nbar\n");
    expect(r.comments).toEqual(["# a comment", "# another"]);
    expect(r.patterns).toEqual(["foo", "bar"]);
  });

  it("reports negation lines as unsupported", () => {
    const r = planGitImport("dist/\n!important.txt\n!keep.log\n");
    expect(r.unsupportedNegations).toEqual(["!important.txt", "!keep.log"]);
    expect(r.patterns).toEqual(["dist/"]);
  });

  it("handles empty / whitespace-only input", () => {
    const r = planGitImport("\n\n   \n");
    expect(r.patterns).toEqual([]);
    expect(r.comments).toEqual([]);
  });
});

describe("renderVscodesyncIgnore", () => {
  it("starts with a header comment", () => {
    const out = renderVscodesyncIgnore({ patterns: ["a"], unsupportedNegations: [], comments: [] });
    expect(out).toMatch(/^# Imported from \.gitignore/);
    expect(out).toContain("\na\n");
  });

  it("notes skipped negations", () => {
    const out = renderVscodesyncIgnore({
      patterns: ["a"],
      unsupportedNegations: ["!b"],
      comments: [],
    });
    expect(out).toContain("1 negation rule(s) skipped");
  });
});

describe("parseGitHead", () => {
  it("parses ref: refs/heads/<branch>", () => {
    const r = parseGitHead("ref: refs/heads/feature/x");
    expect(r.kind).toBe("branch");
    if (r.kind === "branch") expect(r.branch).toBe("feature/x");
  });

  it("parses a 40-char SHA as detached", () => {
    const r = parseGitHead("0123456789abcdef0123456789abcdef01234567");
    expect(r.kind).toBe("detached");
  });

  it("returns 'unparseable' on garbage", () => {
    expect(parseGitHead("nope nope nope").kind).toBe("unparseable");
    expect(parseGitHead("").kind).toBe("unparseable");
  });
});

describe("compareGitBranches", () => {
  it("match when both sides have the same branch", () => {
    const v = compareGitBranches({ kind: "branch", branch: "main" }, "main");
    expect(v.kind).toBe("match");
  });

  it("diverged when branches differ", () => {
    const v = compareGitBranches({ kind: "branch", branch: "feature/x" }, "main");
    expect(v.kind).toBe("diverged");
    if (v.kind === "diverged") {
      expect(v.localBranch).toBe("feature/x");
      expect(v.cloudBranch).toBe("main");
    }
  });

  it("local_detached when local HEAD is detached", () => {
    const v = compareGitBranches({ kind: "detached", sha: "abc1234" }, "main");
    expect(v.kind).toBe("local_detached");
  });

  it("cloud_unset when cloud has no branch", () => {
    const v = compareGitBranches({ kind: "branch", branch: "main" }, undefined);
    expect(v.kind).toBe("cloud_unset");
  });

  it("describeBranchVerdict produces a human-readable string", () => {
    expect(describeBranchVerdict({ kind: "match", branch: "main" })).toContain("matches");
    expect(
      describeBranchVerdict({ kind: "diverged", localBranch: "f", cloudBranch: "m" }),
    ).toContain("differs");
  });
});
