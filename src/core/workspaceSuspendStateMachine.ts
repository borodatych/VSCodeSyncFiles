/**
 * Cross-cutting — discriminated-union state machine for the
 * `WorkspaceSyncState` lifecycle (`active` / `suspended` / `frozen`).
 *
 * Centralises:
 *   - the transition table (which next-states each current state may move to);
 *   - the labels / explanations the UI surfaces in the tree-item context;
 *   - the engine-side guard ("can the user push from this workspace right
 *     now?").
 *
 * No `vscode` import. Caller persists `WorkspaceSyncState` in
 * `vscodesync.json` per workspace.
 */

import type { WorkspaceSyncState } from "./types.js";

export type WorkspaceTransitionAction =
  | { ok: true; newState: WorkspaceSyncState }
  | { ok: false; reason: WorkspaceTransitionReason };

export type WorkspaceTransitionReason =
  | "already_in_state"
  | "frozen_requires_unfreeze_first"
  | "unknown_action";

export type WorkspaceTransitionInput =
  | "suspend"
  | "resume"
  | "freeze"
  | "unfreeze";

const TRANSITIONS: Record<WorkspaceSyncState, Partial<Record<WorkspaceTransitionInput, WorkspaceSyncState>>> = {
  active: { suspend: "suspended", freeze: "frozen" },
  suspended: { resume: "active", freeze: "frozen" },
  // Unfreeze returns directly to active because the unfreeze flow also runs
  // a manifest repair + full sync — both are blocked when the destination
  // state is suspended.
  frozen: { unfreeze: "active" },
};

/** Move from `current` state via `action`. Returns the new state on success
 * or a reason for the rejection — UI can map reasons to user-friendly
 * messages. */
export function transitionWorkspaceSyncState(
  current: WorkspaceSyncState,
  action: WorkspaceTransitionInput,
): WorkspaceTransitionAction {
  const map = TRANSITIONS[current];
  const newState = map[action];
  if (newState !== undefined) {
    if (newState === current) {
      return { ok: false, reason: "already_in_state" };
    }
    return { ok: true, newState };
  }
  // Frozen workspaces must explicitly unfreeze before any other action.
  if (current === "frozen" && action !== "unfreeze") {
    return { ok: false, reason: "frozen_requires_unfreeze_first" };
  }
  return { ok: false, reason: "unknown_action" };
}

/** Engine-side guard: can the user push / pull from this workspace? */
export function canSyncFromWorkspace(state: WorkspaceSyncState): boolean {
  return state === "active";
}

/** Render a one-liner the UI shows in the tree-item description. */
export function describeWorkspaceState(state: WorkspaceSyncState): string {
  switch (state) {
    case "active":
      return "Active — sync runs normally.";
    case "suspended":
      return "Suspended — manual sync only; auto triggers paused.";
    case "frozen":
      return "Frozen — read-only on this machine; unfreeze to enable sync.";
  }
}

/** Enumerate the actions the UI menu should show for a given state. */
export function listAvailableActions(state: WorkspaceSyncState): WorkspaceTransitionInput[] {
  return Object.keys(TRANSITIONS[state]) as WorkspaceTransitionInput[];
}

/** Map (action × rejection reason) to the user-facing Russian message the
 * 4 lifecycle commands surface via `showWarningMessage`. */
export function mapTransitionRejection(
  action: WorkspaceTransitionInput,
  reason: WorkspaceTransitionReason,
): string {
  if (action === "freeze" && reason === "frozen_requires_unfreeze_first") {
    return "VSCodeSync: workspace уже в Freeze.";
  }
  if (reason === "frozen_requires_unfreeze_first") {
    return "VSCodeSync: workspace заморожен — сначала Unfreeze.";
  }
  switch (action) {
    case "suspend":
      return "VSCodeSync: Suspend доступен только из Active.";
    case "resume":
      return "VSCodeSync: Resume только для workspace в Suspend.";
    case "freeze":
      return "VSCodeSync: Freeze недоступен из текущего состояния.";
    case "unfreeze":
      return "VSCodeSync: Unfreeze только для workspace в Freeze.";
  }
}
