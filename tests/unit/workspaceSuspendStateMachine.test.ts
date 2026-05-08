import { describe, expect, it } from "vitest";
import {
  canSyncFromWorkspace,
  describeWorkspaceState,
  listAvailableActions,
  mapTransitionRejection,
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

  it("can unfreeze directly to active (unfreeze runs a full sync)", () => {
    expect(transitionWorkspaceSyncState("frozen", "unfreeze")).toEqual({
      ok: true,
      newState: "active",
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

describe("mapTransitionRejection", () => {
  it("returns 'уже в Freeze' for freeze on frozen", () => {
    expect(mapTransitionRejection("freeze", "frozen_requires_unfreeze_first")).toContain("уже в Freeze");
  });

  it("returns 'сначала Unfreeze' for non-freeze actions on frozen", () => {
    expect(mapTransitionRejection("suspend", "frozen_requires_unfreeze_first")).toContain("сначала Unfreeze");
    expect(mapTransitionRejection("resume", "frozen_requires_unfreeze_first")).toContain("сначала Unfreeze");
  });

  it("returns action-specific message for unknown_action", () => {
    expect(mapTransitionRejection("suspend", "unknown_action")).toContain("Suspend");
    expect(mapTransitionRejection("resume", "unknown_action")).toContain("Resume");
    expect(mapTransitionRejection("freeze", "unknown_action")).toContain("Freeze");
    expect(mapTransitionRejection("unfreeze", "unknown_action")).toContain("Unfreeze");
  });

  it("returns a non-empty string for every (action, reason) pair", () => {
    const actions = ["suspend", "resume", "freeze", "unfreeze"] as const;
    const reasons = ["already_in_state", "frozen_requires_unfreeze_first", "unknown_action"] as const;
    for (const a of actions) {
      for (const r of reasons) {
        expect(mapTransitionRejection(a, r).length).toBeGreaterThan(0);
      }
    }
  });
});
