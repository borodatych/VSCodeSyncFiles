import { describe, expect, it } from "vitest";
import {
  canSyncFromWorkspace,
  describeWorkspaceState,
  listAvailableActions,
  transitionWorkspaceSyncState,
} from "../../src/core/workspaceSuspendStateMachine.js";

describe("transitionWorkspaceSyncState — active state", () => {
  it("can suspend", () => {
    expect(transitionWorkspaceSyncState("active", "suspend")).toEqual({
      ok: true,
      newState: "suspended",
    });
  });

  it("can freeze", () => {
    expect(transitionWorkspaceSyncState("active", "freeze")).toEqual({
      ok: true,
      newState: "frozen",
    });
  });

  it("rejects resume (already active)", () => {
    expect(transitionWorkspaceSyncState("active", "resume")).toEqual({
      ok: false,
      reason: "unknown_action",
    });
  });

  it("rejects unfreeze when not frozen", () => {
    expect(transitionWorkspaceSyncState("active", "unfreeze")).toEqual({
      ok: false,
      reason: "unknown_action",
    });
  });
});

describe("transitionWorkspaceSyncState — suspended state", () => {
  it("can resume to active", () => {
    expect(transitionWorkspaceSyncState("suspended", "resume")).toEqual({
      ok: true,
      newState: "active",
    });
  });

  it("can freeze from suspended", () => {
    expect(transitionWorkspaceSyncState("suspended", "freeze")).toEqual({
      ok: true,
      newState: "frozen",
    });
  });

  it("rejects suspend when already suspended (unknown action — no transition)", () => {
    expect(transitionWorkspaceSyncState("suspended", "suspend")).toEqual({
      ok: false,
      reason: "unknown_action",
    });
  });
});

describe("transitionWorkspaceSyncState — frozen state", () => {
  it("requires unfreeze before any other action", () => {
    expect(transitionWorkspaceSyncState("frozen", "resume")).toEqual({
      ok: false,
      reason: "frozen_requires_unfreeze_first",
    });
    expect(transitionWorkspaceSyncState("frozen", "suspend")).toEqual({
      ok: false,
      reason: "frozen_requires_unfreeze_first",
    });
  });

  it("can unfreeze to suspended (not directly to active)", () => {
    expect(transitionWorkspaceSyncState("frozen", "unfreeze")).toEqual({
      ok: true,
      newState: "suspended",
    });
  });
});

describe("canSyncFromWorkspace", () => {
  it("returns true only for active", () => {
    expect(canSyncFromWorkspace("active")).toBe(true);
    expect(canSyncFromWorkspace("suspended")).toBe(false);
    expect(canSyncFromWorkspace("frozen")).toBe(false);
  });
});

describe("describeWorkspaceState", () => {
  it("returns a non-empty user-facing string for every state", () => {
    expect(describeWorkspaceState("active")).toContain("Active");
    expect(describeWorkspaceState("suspended")).toContain("Suspended");
    expect(describeWorkspaceState("frozen")).toContain("Frozen");
  });
});

describe("listAvailableActions", () => {
  it("lists the actions menu for active state", () => {
    expect(listAvailableActions("active").sort()).toEqual(["freeze", "suspend"]);
  });

  it("lists the actions menu for suspended state", () => {
    expect(listAvailableActions("suspended").sort()).toEqual(["freeze", "resume"]);
  });

  it("lists only unfreeze for frozen state", () => {
    expect(listAvailableActions("frozen")).toEqual(["unfreeze"]);
  });
});
