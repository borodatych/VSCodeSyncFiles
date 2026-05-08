/**
 * v2.3.4 — pure decision helper for the BLAKE3 transition window.
 *
 * Caller has already populated dual-hash entries via the existing
 * `dual` workflow (`vscodesync.canonicalHashAlgo: "dual"`). This module
 * answers: "given how long we've been running dual + how many entries
 * have caught up, should the user flip the setting to `blake3` now?"
 *
 * Three responses:
 *   - `stay_sha256`  → user opted out / workflow not started, keep
 *                      current setting.
 *   - `stay_dual`    → grace window not yet elapsed OR coverage too low.
 *   - `recommend_switch` → grace elapsed AND coverage ≥ ready threshold,
 *                       but the user must explicitly confirm.
 *   - `safe_to_switch_now` → 100% coverage AND grace elapsed; the
 *                            "complete migration" command can fire
 *                            without further re-hashing.
 *
 * No `vscode` import. Caller persists `dualWorkflowStartedMs` in
 * globalState.
 */

export type CanonicalHashAlgo = "sha256" | "dual" | "blake3";

export type Blake3MigrationAction =
  | "stay_sha256"
  | "stay_dual"
  | "recommend_switch"
  | "safe_to_switch_now";

export interface Blake3MigrationDecisionInput {
  currentSetting: CanonicalHashAlgo;
  /** ms timestamp when `currentSetting` first flipped to `dual`. null when
   * dual workflow has not started or globalState was wiped. */
  dualWorkflowStartedMs: number | null;
  /** ms — caller-supplied "now". */
  nowMs: number;
  /** How long we want to give the dual workflow before recommending a
   * switch. Default 7 days, matching the docs in v2/breakdown.md. */
  gracePeriodMs?: number;
  /** Fraction in [0..1] of meta entries that already carry hashBlake3.
   * Source: `runHashAlgoMigrationCheck(...).ratioWithBlake3`. */
  completedRatio: number;
  /** Minimum coverage to recommend a switch (default 0.95 — 95% have
   * BLAKE3 alongside sha256). Below this the user is still in dual. */
  recommendThreshold?: number;
}

export interface Blake3MigrationDecision {
  action: Blake3MigrationAction;
  /** Short reason code suitable for telemetry / log. */
  reason: Blake3MigrationReason;
  /** ms — when the next probe should consider this decision again. null
   * means "no need to revisit, decision is terminal". */
  nextProbeMs: number | null;
}

export type Blake3MigrationReason =
  | "setting_off"
  | "setting_already_blake3"
  | "no_workflow_started"
  | "grace_pending"
  | "coverage_too_low"
  | "threshold_reached"
  | "full_coverage";

export const DEFAULT_GRACE_PERIOD_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_RECOMMEND_THRESHOLD = 0.95;

export function planBlake3MigrationAction(
  input: Blake3MigrationDecisionInput,
): Blake3MigrationDecision {
  if (input.currentSetting === "sha256") {
    return { action: "stay_sha256", reason: "setting_off", nextProbeMs: null };
  }
  if (input.currentSetting === "blake3") {
    return {
      action: "safe_to_switch_now",
      reason: "setting_already_blake3",
      nextProbeMs: null,
    };
  }
  // currentSetting === "dual"
  if (input.dualWorkflowStartedMs === null) {
    return { action: "stay_sha256", reason: "no_workflow_started", nextProbeMs: null };
  }
  const grace = input.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const elapsed = input.nowMs - input.dualWorkflowStartedMs;
  if (elapsed < grace) {
    return {
      action: "stay_dual",
      reason: "grace_pending",
      nextProbeMs: input.dualWorkflowStartedMs + grace,
    };
  }
  if (input.completedRatio >= 1) {
    return {
      action: "safe_to_switch_now",
      reason: "full_coverage",
      nextProbeMs: null,
    };
  }
  const threshold = input.recommendThreshold ?? DEFAULT_RECOMMEND_THRESHOLD;
  if (input.completedRatio >= threshold) {
    return {
      action: "recommend_switch",
      reason: "threshold_reached",
      nextProbeMs: null,
    };
  }
  return {
    action: "stay_dual",
    reason: "coverage_too_low",
    nextProbeMs: null,
  };
}
