import { describe, expect, it } from "vitest";
import { planBranchMismatchAction } from "../../src/core/branchMismatchPlanner.js";
import type { GitBranchCompareVerdict } from "../../src/core/gitHeadCompare.js";

describe("planBranchMismatchAction", () => {
  it("match + autoFetch + clean → auto_fetch", () => {
    const verdict: GitBranchCompareVerdict = { kind: "match", branch: "main" };
    const r = planBranchMismatchAction({ verdict, autoFetchOnMatch: true, localDirty: false });
    expect(r.action).toBe("auto_fetch");
  });

  it("match + autoFetch + dirty → noop (avoid checkout collision)", () => {
    const verdict: GitBranchCompareVerdict = { kind: "match", branch: "main" };
    const r = planBranchMismatchAction({ verdict, autoFetchOnMatch: true, localDirty: true });
    expect(r.action).toBe("noop");
  });

  it("match without autoFetch → noop", () => {
    const verdict: GitBranchCompareVerdict = { kind: "match", branch: "main" };
    const r = planBranchMismatchAction({ verdict, autoFetchOnMatch: false, localDirty: false });
    expect(r.action).toBe("noop");
  });

  it("diverged → offer_fetch with message naming both branches", () => {
    const verdict: GitBranchCompareVerdict = {
      kind: "diverged",
      localBranch: "feature/x",
      cloudBranch: "main",
    };
    const r = planBranchMismatchAction({ verdict, autoFetchOnMatch: false, localDirty: false });
    expect(r.action).toBe("offer_fetch");
    if (r.action === "offer_fetch") {
      expect(r.message).toContain("feature/x");
      expect(r.message).toContain("main");
    }
  });

  it("local_detached → warn_toast with short SHA", () => {
    const verdict: GitBranchCompareVerdict = {
      kind: "local_detached",
      localSha: "abcdef1234567890",
      cloudBranch: "main",
    };
    const r = planBranchMismatchAction({ verdict, autoFetchOnMatch: false, localDirty: false });
    expect(r.action).toBe("warn_toast");
    if (r.action === "warn_toast") {
      expect(r.message).toContain("abcdef1");
      expect(r.message).toContain("detached");
    }
  });

  it("cloud_unset → noop (legacy manifest)", () => {
    const verdict: GitBranchCompareVerdict = {
      kind: "cloud_unset",
      localBranch: "main",
    };
    const r = planBranchMismatchAction({ verdict, autoFetchOnMatch: true, localDirty: false });
    expect(r.action).toBe("noop");
  });

  it("local_unparseable → warn_toast", () => {
    const verdict: GitBranchCompareVerdict = { kind: "local_unparseable" };
    const r = planBranchMismatchAction({ verdict, autoFetchOnMatch: false, localDirty: false });
    expect(r.action).toBe("warn_toast");
  });
});
