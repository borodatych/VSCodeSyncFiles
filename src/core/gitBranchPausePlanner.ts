/**
 * Auto-pause for workspaces that are NOT bound to a git branch.
 *
 * Bound workspaces (`gitBranch` set) already have a policy: they follow their
 * branch — see `ui/gitBranchWorkspaceActivation.ts`. Unbound ones had none, so
 * a `git checkout` on a big repo refilled the tree with `pending_push` for
 * every file the checkout touched. That is exactly the noise a pause is for,
 * and until now the user had to pause by hand and remember to resume.
 *
 * The rule is deliberately narrow:
 *   - the branch actually changed since the last pass (`lastSeenGitBranch`),
 *   - the workspace is active → pause it, remembering the branch we left;
 *   - we are back on that remembered branch → resume it.
 *
 * Anything the user paused by hand carries no `autoPausedFromBranch`, so it is
 * never auto-resumed: undoing a human decision on a background event is worse
 * than leaving a workspace paused.
 *
 * Pure — no `vscode`, no I/O.
 */

export interface BranchPauseEntryInput {
  workspaceId: string;
  workspaceNote: string;
  /** Normalized `gitBranch` binding, if any. Bound entries are skipped here. */
  gitBranch?: string;
  /** Result of `normalizeWorkspaceSyncState` for this entry. */
  syncState: "active" | "suspended" | "frozen";
  lastSeenGitBranch?: string;
  autoPausedFromBranch?: string;
}

export interface BranchPausePlanInput {
  /** Normalized current branch, or undefined when HEAD is detached/unreadable. */
  currentBranch: string | undefined;
  entries: readonly BranchPauseEntryInput[];
  /** Setting `vscodesync.git.autoSuspendUnbound`. */
  enabled: boolean;
}

export type BranchPauseAction =
  | { kind: "suspend"; workspaceId: string; workspaceNote: string; fromBranch: string }
  | { kind: "resume"; workspaceId: string; workspaceNote: string; branch: string };

export interface BranchPausePlan {
  actions: BranchPauseAction[];
  /** Entries whose `lastSeenGitBranch` must be rewritten to `currentBranch`. */
  rememberBranchFor: string[];
}

const EMPTY: BranchPausePlan = { actions: [], rememberBranchFor: [] };

export function planUnboundBranchPause(input: BranchPausePlanInput): BranchPausePlan {
  // Detached HEAD or an unreadable ref: we cannot name the branch we would
  // return to, so recording it would strand the workspace in a pause nothing
  // lifts. Better to do nothing at all.
  if (!input.enabled || input.currentBranch === undefined || input.currentBranch === "") {
    return EMPTY;
  }
  const current = input.currentBranch;
  const actions: BranchPauseAction[] = [];
  const rememberBranchFor: string[] = [];

  for (const e of input.entries) {
    const bound = e.gitBranch?.trim();
    if (bound !== undefined && bound !== "") {
      continue; // Bound workspaces belong to the branch-binding policy.
    }
    if (e.lastSeenGitBranch !== current) {
      rememberBranchFor.push(e.workspaceId);
    }
    if (e.syncState === "frozen") {
      continue; // Freeze is stricter than pause; nothing to add or undo.
    }
    if (e.autoPausedFromBranch !== undefined && e.autoPausedFromBranch !== "") {
      if (e.autoPausedFromBranch === current && e.syncState === "suspended") {
        actions.push({ kind: "resume", workspaceId: e.workspaceId, workspaceNote: e.workspaceNote, branch: current });
      }
      continue;
    }
    const previous = e.lastSeenGitBranch;
    if (
      e.syncState === "active" &&
      previous !== undefined &&
      previous !== "" &&
      previous !== current
    ) {
      actions.push({
        kind: "suspend",
        workspaceId: e.workspaceId,
        workspaceNote: e.workspaceNote,
        fromBranch: previous,
      });
    }
  }

  return { actions, rememberBranchFor };
}

/** Toast text for a batch of auto-pauses; `null` when there is nothing to say. */
export function describeAutoPause(actions: readonly BranchPauseAction[], currentBranch: string): string | null {
  const suspended = actions.filter((a) => a.kind === "suspend");
  const resumed = actions.filter((a) => a.kind === "resume");
  if (suspended.length === 0 && resumed.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (suspended.length > 0) {
    parts.push(`приостановлено ${String(suspended.length)} — ветка сменилась на «${currentBranch}»`);
  }
  if (resumed.length > 0) {
    parts.push(`возобновлено ${String(resumed.length)} — вернулись на «${currentBranch}»`);
  }
  return `VSCodeSync: ${parts.join("; ")}.`;
}
