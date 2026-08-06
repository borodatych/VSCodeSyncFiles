/**
 * The one place that decides what to do with a tracked file (C17).
 *
 * The verdict was reached in four places — `checkOneFileStatus`, `syncOneFile`,
 * `previewSyncPlan` and `reconcileBeforePushUpload` — and only the first
 * carried the extra `localHash !== cloudHash` term in its consensus-lag guard.
 * The other three therefore answered "pull" for a file whose local content
 * already equals the cloud's, purely because the cached `file.localHash` was
 * stale (edit, then undo the edit). The status then flip-flopped between ticks:
 * the panel showed "↓1", Pull moved nothing, the next check said "ok".
 *
 * The strict variant is canonical, and it lives here so the four callers cannot
 * drift apart again.
 *
 * Pure: hashes in, verdict out. No I/O, no engine state, no `vscode`.
 */
import { detectChange, type ChangeAction } from "../changeDetection.js";
import type { TrackedSyncStatus } from "../types.js";

export interface FileActionInput {
  /** `_meta.files[path].hash` — the last hash both sides agreed on. */
  baseHash: string | undefined;
  /** `file.localHash` from the workspace config: what we *think* is local. */
  cachedLocalHash: string;
  /** Canonical hash of the file on disk right now. `""` when absent. */
  localHash: string;
  /** Canonical hash of the cloud blob right now. `""` when absent. */
  cloudHash: string;
}

export interface PlannedFileAction {
  action: ChangeAction;
  /**
   * Why, in machine-readable form. `consensus_lag` marks the case the guard
   * exists for: another machine advanced `_meta` while our cached hash stayed
   * behind, so a naive 3-way read would call it "push" and overwrite them.
   */
  reason: "consensus_lag" | "three_way";
}

export function planFileAction(input: FileActionInput): PlannedFileAction {
  if (consensusLagsLocally(input)) {
    return { action: "pull", reason: "consensus_lag" };
  }
  return { action: detectChange(input.baseHash, input.localHash, input.cloudHash), reason: "three_way" };
}

/**
 * The cloud still matches the agreed baseline, our cached hash does not, and
 * the file on disk genuinely differs from the cloud.
 *
 * That last term is what the three lax copies were missing: without it, a file
 * edited and then reverted (local content back to the cloud's) reads as "pull"
 * forever, because `cachedLocalHash` alone never catches up.
 */
function consensusLagsLocally(input: FileActionInput): boolean {
  return (
    input.baseHash !== undefined &&
    input.baseHash !== "" &&
    input.cachedLocalHash !== input.baseHash &&
    input.cloudHash === input.baseHash &&
    input.localHash !== input.cloudHash
  );
}

/** How a planned action shows up in the workspace config / UI. */
export function syncStatusForAction(action: ChangeAction): TrackedSyncStatus {
  switch (action) {
    case "push":
      return "pending_push";
    case "pull":
      return "cloud_newer";
    case "none":
      return "ok";
    case "conflict":
      return "conflict";
  }
}
