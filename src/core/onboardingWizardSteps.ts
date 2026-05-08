/**
 * v1 Phase 3 — pure step planner for the onboarding wizard
 * (`Start Onboarding Wizard` command). Mirrors the orchestration shape used
 * by `keyRotationWizardSteps` / `bulkPushAiReviewFlow` /
 * `p2pSessionWizardSteps`: UI walks `steps[]` linearly.
 *
 * The wizard branches on three observed states: provider already configured?
 * workspace already attached? machine already named? The planner decides
 * which steps to skip when the user is partway through.
 *
 * No `vscode` import.
 */

import type { ProviderType } from "./types.js";

export type OnboardingStep =
  | "intro"
  | "pick_provider"
  | "authenticate_provider"
  | "name_machine"
  | "pick_or_create_workspace"
  | "configure_ignore_patterns"
  | "first_sync"
  | "done";

export interface OnboardingPlan {
  steps: OnboardingStep[];
  /** Reason any branch was taken — feeds telemetry + the wizard's
   * "(skipped — already configured)" hints. */
  decisions: OnboardingDecision[];
}

export type OnboardingDecision =
  | { step: "pick_provider"; reason: "skip_already_configured" | "include" }
  | { step: "authenticate_provider"; reason: "skip_already_authenticated" | "include" }
  | { step: "name_machine"; reason: "skip_already_named" | "include" }
  | { step: "pick_or_create_workspace"; reason: "skip_already_attached" | "include" };

export interface PlanOnboardingInput {
  /** True when an active provider is set in `globalConfig`. */
  hasActiveProvider: boolean;
  /** True when the active provider already has a token in SecretStorage. */
  hasAuthenticatedTokens: boolean;
  /** True when `globalConfig.machineName` is non-empty. */
  hasMachineName: boolean;
  /** True when at least one workspace is attached locally. */
  hasAttachedWorkspace: boolean;
  /** Optional pre-selected provider type — drives the
   * `authenticate_provider` step text without re-asking. */
  preselectedProvider?: ProviderType;
}

export function planOnboardingWizard(input: PlanOnboardingInput): OnboardingPlan {
  const steps: OnboardingStep[] = ["intro"];
  const decisions: OnboardingDecision[] = [];

  if (input.hasActiveProvider) {
    decisions.push({ step: "pick_provider", reason: "skip_already_configured" });
  } else {
    decisions.push({ step: "pick_provider", reason: "include" });
    steps.push("pick_provider");
  }

  if (input.hasActiveProvider && input.hasAuthenticatedTokens) {
    decisions.push({ step: "authenticate_provider", reason: "skip_already_authenticated" });
  } else {
    decisions.push({ step: "authenticate_provider", reason: "include" });
    steps.push("authenticate_provider");
  }

  if (input.hasMachineName) {
    decisions.push({ step: "name_machine", reason: "skip_already_named" });
  } else {
    decisions.push({ step: "name_machine", reason: "include" });
    steps.push("name_machine");
  }

  if (input.hasAttachedWorkspace) {
    decisions.push({ step: "pick_or_create_workspace", reason: "skip_already_attached" });
  } else {
    decisions.push({ step: "pick_or_create_workspace", reason: "include" });
    steps.push("pick_or_create_workspace");
  }

  // configure_ignore_patterns and first_sync always follow because the
  // wizard either attached an existing workspace or just created one.
  steps.push("configure_ignore_patterns", "first_sync", "done");

  return { steps, decisions };
}

/** True when every step in the wizard is satisfied by current state — the
 * wizard would only show the "done" screen. The UI uses this to skip
 * showing the wizard at all on subsequent launches. */
export function isOnboardingAlreadyComplete(input: PlanOnboardingInput): boolean {
  return (
    input.hasActiveProvider &&
    input.hasAuthenticatedTokens &&
    input.hasMachineName &&
    input.hasAttachedWorkspace
  );
}
