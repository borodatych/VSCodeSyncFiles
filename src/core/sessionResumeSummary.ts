/**
 * v2.6.7 — pure summariser for the "session resume" preview plan.
 *
 * `extension.ts:runAfterSessionResume` previously inlined the totals
 * computation (push/pull/conflict counts) and the modal message body. This
 * module pulls both into pure helpers so the closure shrinks and the
 * formatting is unit-testable.
 *
 * The `WorkspacePreviewPlan` shape is the same one returned by
 * `SyncEngine.previewSyncPlan()`: each plan has a `files[]` array where
 * each file has `action: "push" | "pull" | "conflict" | "conflict_pending"
 * | "skip" | ...`. We don't import the engine type directly to keep this
 * module vscode-free.
 */

export type ResumeFileAction =
  | "push"
  | "pull"
  | "conflict"
  | "conflict_pending"
  | "skip"
  | "no_op";

export interface ResumeFileEntry {
  /** Free-form because real `previewSyncPlan` may evolve action labels and
   *  this summariser must keep counting only the canonical ones. */
  readonly action: string;
}

export interface ResumeWorkspacePlan {
  readonly files: readonly ResumeFileEntry[];
}

export interface ResumeTotals {
  readonly push: number;
  readonly pull: number;
  readonly conflict: number;
}

export function summariseResumePlans(plans: readonly ResumeWorkspacePlan[]): ResumeTotals {
  let push = 0;
  let pull = 0;
  let conflict = 0;
  for (const plan of plans) {
    for (const f of plan.files) {
      if (f.action === "push") push += 1;
      else if (f.action === "pull") pull += 1;
      else if (f.action === "conflict" || f.action === "conflict_pending") conflict += 1;
    }
  }
  return { push, pull, conflict };
}

/**
 * Modal message body for the post-resume "Sync now?" prompt. Localised in
 * Russian to match existing UX strings; caller appends action buttons.
 */
export function formatResumeSummaryMessage(totals: ResumeTotals): string {
  return [
    "VSCodeSync: пауза снята.",
    `План: ↑ push ${String(totals.push)} · ↓ pull ${String(totals.pull)} · конфликты ${String(totals.conflict)}.`,
    "Детали — Output «VSCodeSync · Preview».",
  ].join("\n");
}

/**
 * Pure decision: given totals and presence-of-roots, what should the wrapper
 * do next? Avoids re-implementing this branching three times in the
 * `runAfterSessionResume` closure.
 */
export type ResumeAction = "abort_no_provider" | "abort_no_roots" | "show_plan";

export function decideResumeAction(input: {
  hasProvider: boolean;
  hasActiveRoot: boolean;
}): ResumeAction {
  if (!input.hasProvider) return "abort_no_provider";
  if (!input.hasActiveRoot) return "abort_no_roots";
  return "show_plan";
}
