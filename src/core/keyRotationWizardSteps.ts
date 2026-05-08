/**
 * v3.D — pure step planner for the `vscodesync.rotateEncryptionKey`
 * QuickPick wizard. Mirrors the approach used by `bulkPushAiReviewFlow`:
 * the UI walks the returned `steps[]` in order; this module decides
 * which steps to include and what each step's payload should be.
 *
 * The actual rotation work runs through `planKeyRotation` (already pure)
 * — this layer is just orchestration.
 *
 * No `vscode` import.
 */

import type { RotationPlan } from "./keyRotationPlan.js";

export type KeyRotationStep =
  | "preflight"
  | "confirm_scope"
  | "fallback_setup"
  | "batch_process"
  | "verify"
  | "done";

export interface KeyRotationWizardPlan {
  steps: KeyRotationStep[];
  /** Reason the fallback step was added or skipped. */
  fallbackDecision: "fallback_required" | "fallback_present" | "fallback_skipped_no_op";
  /** Reason verify was added or skipped (skip if zero items pending). */
  verifyDecision: "verify_enabled" | "skip_no_items";
  /** Caller may choose to render this as a banner before confirm_scope. */
  warnings: KeyRotationWarning[];
}

export type KeyRotationWarning =
  | "no_recovery_codes"
  | "very_large_dataset"
  | "resumed_partial_state";

export interface PlanKeyRotationWizardOptions {
  /** Result of `planKeyRotation(items, ...)` from the same wizard pre-step. */
  rotationPlan: RotationPlan;
  /** True when the user has at least one passphrase / recovery-code / WebAuthn
   * fallback configured. Without it, a failed rotation = data loss. */
  hasFallback: boolean;
  /** True when `_meta.json.rotationInProgress` already exists — i.e. the
   * wizard is being resumed after an interruption. */
  resumingPartial: boolean;
  /** Threshold in bytes above which we surface the "very large dataset"
   * warning so the user can opt in explicitly. Default 1 GiB. */
  largeDatasetThresholdBytes?: number;
}

const DEFAULT_LARGE_DATASET_THRESHOLD_BYTES = 1 * 1024 * 1024 * 1024;

export function planKeyRotationWizard(options: PlanKeyRotationWizardOptions): KeyRotationWizardPlan {
  const { rotationPlan, hasFallback, resumingPartial } = options;
  const largeThreshold =
    options.largeDatasetThresholdBytes ?? DEFAULT_LARGE_DATASET_THRESHOLD_BYTES;

  const steps: KeyRotationStep[] = ["preflight", "confirm_scope"];

  const fallbackDecision = decideFallback(rotationPlan, hasFallback);
  if (fallbackDecision === "fallback_required") {
    steps.push("fallback_setup");
  }

  const verifyDecision: KeyRotationWizardPlan["verifyDecision"] =
    rotationPlan.remainingFiles > 0 ? "verify_enabled" : "skip_no_items";

  if (verifyDecision === "verify_enabled") {
    steps.push("batch_process", "verify");
  }
  steps.push("done");

  const warnings: KeyRotationWarning[] = [];
  if (!hasFallback && rotationPlan.remainingFiles > 0) {
    warnings.push("no_recovery_codes");
  }
  if (rotationPlan.totalBytes >= largeThreshold) {
    warnings.push("very_large_dataset");
  }
  if (resumingPartial) {
    warnings.push("resumed_partial_state");
  }

  return { steps, fallbackDecision, verifyDecision, warnings };
}

function decideFallback(
  rotationPlan: RotationPlan,
  hasFallback: boolean,
): KeyRotationWizardPlan["fallbackDecision"] {
  if (rotationPlan.remainingFiles === 0) return "fallback_skipped_no_op";
  if (hasFallback) return "fallback_present";
  return "fallback_required";
}

/** Format the wizard plan into a single human-readable summary for the
 * preflight QuickPick title / description. UI layer maps the strings into
 * `vscode.QuickPickItem` rows. */
export interface KeyRotationWizardSummary {
  title: string;
  description: string;
  detail: string;
}

export function summariseKeyRotationWizard(
  plan: KeyRotationWizardPlan,
  rotationPlan: RotationPlan,
): KeyRotationWizardSummary {
  const totalMb = (rotationPlan.totalBytes / (1024 * 1024)).toFixed(1);
  const remainingMb = (rotationPlan.remainingBytes / (1024 * 1024)).toFixed(1);
  const stepNames = plan.steps.join(" → ");
  return {
    title: `Rotate encryption key — ${String(rotationPlan.remainingFiles)} files / ${remainingMb} MB pending`,
    description: `${String(rotationPlan.batches.length)} batches, ${String(plan.warnings.length)} warning(s)`,
    detail: `Total ${String(rotationPlan.totalFiles)} files / ${totalMb} MB. Steps: ${stepNames}`,
  };
}
