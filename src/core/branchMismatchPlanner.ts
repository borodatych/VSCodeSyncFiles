/**
 * v3.L — pure decision helper for the engine's post-pull git-fetch hook.
 *
 * The reader (engine sync path) has just compared local `.git/HEAD` with
 * `_meta.json.gitBranch` (via `gitHeadCompare.ts`). This module decides:
 *   - Is a toast warranted?
 *   - Should we offer a `git fetch`?
 *   - Should we silently auto-fetch (when the user opted in)?
 *
 * Pure — no `vscode` import. Caller wires the output into
 * `vscode.window.showWarningMessage(...)` or a silent `child_process.spawn`.
 */
import type { GitBranchCompareVerdict } from "./gitHeadCompare.js";

export type GitBranchAction =
  | { action: "noop" }
  | { action: "warn_toast"; message: string }
  | { action: "offer_fetch"; message: string }
  | { action: "auto_fetch" };

export interface BranchMismatchPlanInput {
  verdict: GitBranchCompareVerdict;
  /** Setting `vscodesync.gitBranchAutoSync` — if true and the branch matches,
   * we auto-fetch silently after pull. */
  autoFetchOnMatch: boolean;
  /** True if local has uncommitted changes. Suppresses auto_fetch suggestions
   * because checkout might collide. */
  localDirty: boolean;
}

export function planBranchMismatchAction(input: BranchMismatchPlanInput): GitBranchAction {
  switch (input.verdict.kind) {
    case "match":
      // Same branch on both sides. Auto-fetch only if user opted in AND
      // working tree is clean enough.
      if (input.autoFetchOnMatch && !input.localDirty) {
        return { action: "auto_fetch" };
      }
      return { action: "noop" };
    case "diverged":
      return {
        action: "offer_fetch",
        message: `Local branch '${input.verdict.localBranch}' differs from cloud '${input.verdict.cloudBranch}'. Run 'git fetch' to inspect, then decide.`,
      };
    case "local_detached":
      return {
        action: "warn_toast",
        message: `Local HEAD is detached (${input.verdict.localSha.slice(0, 7)}); cloud is on '${input.verdict.cloudBranch}'. Reattach a branch before syncing further.`,
      };
    case "cloud_unset":
      // Cloud manifest predates the gitBranch field; nothing to warn about.
      return { action: "noop" };
    case "local_unparseable":
      return {
        action: "warn_toast",
        message: `Could not parse local .git/HEAD; skipping branch comparison.`,
      };
  }
}
