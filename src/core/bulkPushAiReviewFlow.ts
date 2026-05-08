/**
 * v3.H — pure step planner that turns the existing
 * `aiBulkReviewPrompt`-based pipeline into the multi-step QuickPick flow
 * that the `bulkPushWizard` UI command will run.
 *
 * No `vscode` import. Caller (UI layer) walks the returned `steps[]` array
 * in order and decides per step which `QuickPick` / `withProgress` /
 * confirmation modal to render.
 */

import type {
  BulkReviewSummary,
  BulkReviewVerdict,
} from "./aiBulkReviewPrompt.js";

export type BulkPushStep =
  | "confirm_scope"
  | "ai_batch_review"
  | "review_summary"
  | "confirm_apply";

export interface BulkPushFlowPlan {
  steps: BulkPushStep[];
  /** Null when AI review is skipped — caller surfaces a different banner. */
  batchPlan: BulkPushBatchPlan | null;
  /** Reason the AI review step was added or skipped. */
  reviewDecision: BulkPushReviewDecision;
}

export type BulkPushReviewDecision =
  | "review_enabled"
  | "skip_no_files"
  | "skip_disabled"
  | "skip_no_lm";

export interface BulkPushBatchPlan {
  /** Total batches needed to review every file. */
  totalBatches: number;
  /** Max files per batch (caller may render `${i+1}/${total}` progress). */
  perBatchFiles: number;
  /** Last batch may be smaller; caller divides `fileCount` per batch index. */
  fileCount: number;
}

export interface PlanBulkPushFlowOptions {
  fileCount: number;
  aiReviewEnabled: boolean;
  hasLm: boolean;
  /** How many files per LM batch prompt. Default 10 — matches the cap noted
   * in `buildBulkReviewBatchPrompt`. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 10;

export function planBulkPushAiReviewFlow(options: PlanBulkPushFlowOptions): BulkPushFlowPlan {
  const decision = decideReview(options);
  const batchPlan = decision === "review_enabled"
    ? buildBatchPlan(options.fileCount, options.batchSize ?? DEFAULT_BATCH_SIZE)
    : null;
  const steps: BulkPushStep[] = ["confirm_scope"];
  if (decision === "review_enabled") {
    steps.push("ai_batch_review", "review_summary");
  }
  steps.push("confirm_apply");
  return { steps, batchPlan, reviewDecision: decision };
}

function decideReview(options: PlanBulkPushFlowOptions): BulkPushReviewDecision {
  if (options.fileCount <= 0) return "skip_no_files";
  if (!options.aiReviewEnabled) return "skip_disabled";
  if (!options.hasLm) return "skip_no_lm";
  return "review_enabled";
}

function buildBatchPlan(fileCount: number, perBatchFiles: number): BulkPushBatchPlan {
  const safeBatch = Math.max(1, Math.floor(perBatchFiles));
  const totalBatches = Math.ceil(fileCount / safeBatch);
  return { totalBatches, perBatchFiles: safeBatch, fileCount };
}

/** QuickPick-item shape (caller maps it to `vscode.QuickPickItem`). Detached
 * from `vscode` so the planner stays unit-testable. */
export interface BulkPushReviewQuickPickItem {
  label: string;
  description: string;
  detail: string;
  /** Caller decides default selection. We pre-select files whose verdict is
   * NOT in the `high` bucket — i.e. risky overwrites are off-by-default. */
  picked: boolean;
}

const HIGH_RISK_THRESHOLD = 0.7;

/** Format the per-file verdicts into QuickPick-ready descriptors. The
 * caller only renders these — the picker is a `QuickPick` with
 * `canSelectMany: true`. */
export function formatVerdictsForQuickPick(
  verdicts: readonly BulkReviewVerdict[],
): BulkPushReviewQuickPickItem[] {
  const items = verdicts.map((v) => ({
    label: v.relPath,
    description: `risk ${formatRisk(v.riskScore)}`,
    detail: v.summary,
    picked: v.riskScore < HIGH_RISK_THRESHOLD,
  }));
  // Highest risk first so reviewers see them at the top.
  items.sort((a, b) => parseRisk(b.description) - parseRisk(a.description));
  return items;
}

function formatRisk(score: number): string {
  return (Math.round(score * 100) / 100).toFixed(2);
}

function parseRisk(description: string): number {
  const m = /risk (\d+\.\d+)/.exec(description);
  return m ? Number(m[1]) : 0;
}

export type BulkPushConfirmationLevel = "auto_apply" | "confirm" | "explicit_confirm";

export interface BulkPushConfirmationDecision {
  level: BulkPushConfirmationLevel;
  reason: string;
}

/** Decide how strict the final confirmation should be. We escalate to
 * `explicit_confirm` (user must type "apply" or click an extra button) when
 * the AI flagged a high-risk file; we degrade to `auto_apply` only when
 * there are zero pending files (a no-op). */
export function decideBulkPushConfirmation(
  summary: BulkReviewSummary | null,
  fileCount: number,
): BulkPushConfirmationDecision {
  if (fileCount === 0) {
    return { level: "auto_apply", reason: "no_files" };
  }
  if (summary === null) {
    return { level: "confirm", reason: "no_review" };
  }
  if (summary.needsAttention) {
    return { level: "explicit_confirm", reason: "high_risk_present" };
  }
  if (summary.maxRisk >= 0.3) {
    return { level: "confirm", reason: "medium_risk_present" };
  }
  return { level: "confirm", reason: "all_low_risk" };
}
