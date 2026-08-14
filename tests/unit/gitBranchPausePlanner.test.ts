/**
 * Auto-pause for unbound workspaces on a git branch switch — pure planner.
 */
import { describe, expect, it } from "vitest";
import {
  describeAutoPause,
  planUnboundBranchPause,
  type BranchPauseEntryInput,
} from "../../src/core/gitBranchPausePlanner.js";

function entry(extra: Partial<BranchPauseEntryInput> = {}): BranchPauseEntryInput {
  return {
    workspaceId: "w1",
    workspaceNote: "Проект",
    syncState: "active",
    ...extra,
  };
}

describe("planUnboundBranchPause", () => {
  it("does nothing while the setting is off", () => {
    const plan = planUnboundBranchPause({
      currentBranch: "feature",
      enabled: false,
      entries: [entry({ lastSeenGitBranch: "main" })],
    });
    expect(plan.actions).toEqual([]);
    expect(plan.rememberBranchFor).toEqual([]);
  });

  it("suspends an active workspace when the branch changed", () => {
    const plan = planUnboundBranchPause({
      currentBranch: "feature",
      enabled: true,
      entries: [entry({ lastSeenGitBranch: "main" })],
    });
    expect(plan.actions).toEqual([
      { kind: "suspend", workspaceId: "w1", workspaceNote: "Проект", fromBranch: "main" },
    ]);
    expect(plan.rememberBranchFor).toEqual(["w1"]);
  });

  it("stays quiet on the first pass, when no branch was ever recorded", () => {
    const plan = planUnboundBranchPause({
      currentBranch: "main",
      enabled: true,
      entries: [entry()],
    });
    expect(plan.actions).toEqual([]);
    expect(plan.rememberBranchFor).toEqual(["w1"]);
  });

  it("resumes when back on the branch the auto-pause came from", () => {
    const plan = planUnboundBranchPause({
      currentBranch: "main",
      enabled: true,
      entries: [entry({ syncState: "suspended", autoPausedFromBranch: "main", lastSeenGitBranch: "feature" })],
    });
    expect(plan.actions).toEqual([
      { kind: "resume", workspaceId: "w1", workspaceNote: "Проект", branch: "main" },
    ]);
  });

  it("keeps an auto-paused workspace paused on a third branch", () => {
    const plan = planUnboundBranchPause({
      currentBranch: "other",
      enabled: true,
      entries: [entry({ syncState: "suspended", autoPausedFromBranch: "main" })],
    });
    expect(plan.actions).toEqual([]);
  });

  it("never resumes a pause the user set by hand", () => {
    const plan = planUnboundBranchPause({
      currentBranch: "main",
      enabled: true,
      entries: [entry({ syncState: "suspended", lastSeenGitBranch: "feature" })],
    });
    expect(plan.actions).toEqual([]);
  });

  it("leaves bound workspaces to the branch-binding policy", () => {
    const plan = planUnboundBranchPause({
      currentBranch: "feature",
      enabled: true,
      entries: [entry({ gitBranch: "main", lastSeenGitBranch: "main" })],
    });
    expect(plan.actions).toEqual([]);
    expect(plan.rememberBranchFor).toEqual([]);
  });

  it("ignores frozen workspaces", () => {
    const plan = planUnboundBranchPause({
      currentBranch: "feature",
      enabled: true,
      entries: [entry({ syncState: "frozen", lastSeenGitBranch: "main" })],
    });
    expect(plan.actions).toEqual([]);
  });

  it("does nothing on a detached HEAD — there is no branch to return to", () => {
    const plan = planUnboundBranchPause({
      currentBranch: undefined,
      enabled: true,
      entries: [entry({ lastSeenGitBranch: "main" })],
    });
    expect(plan.actions).toEqual([]);
    expect(plan.rememberBranchFor).toEqual([]);
  });
});

describe("describeAutoPause", () => {
  it("returns null when nothing happened", () => {
    expect(describeAutoPause([], "main")).toBeNull();
  });

  it("names both halves of a mixed batch", () => {
    const text = describeAutoPause(
      [
        { kind: "suspend", workspaceId: "a", workspaceNote: "A", fromBranch: "main" },
        { kind: "resume", workspaceId: "b", workspaceNote: "B", branch: "dev" },
      ],
      "dev",
    );
    expect(text).toContain("приостановлено 1");
    expect(text).toContain("возобновлено 1");
  });
});
