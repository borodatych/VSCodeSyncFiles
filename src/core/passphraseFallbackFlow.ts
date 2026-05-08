/**
 * v2.2.4 — pure step planner for the passphrase fallback flow that backs
 * up WebAuthn / FIDO2 enrollment. When the user's passkey is unavailable
 * (lost device, biometrics blocked) they enter the stored passphrase
 * instead, which derives the same KEK that wraps the DEK.
 *
 * Mirrors the shape of `keyRotationWizardSteps` and `bulkPushAiReviewFlow`
 * — UI walks `steps[]` linearly. This module only decides which steps to
 * include and surfaces strength/lockout warnings.
 *
 * No `vscode` import. The actual `crypto.scrypt` / `pbkdf2` derivation
 * runs in the side-effect layer.
 */

export type PassphraseFlowMode = "enroll" | "unlock" | "recover";

export type PassphraseFlowStep =
  | "intro"
  | "passphrase_strength_check"
  | "confirm_passphrase"
  | "derive_kek"
  | "wrap_dek"
  | "unwrap_dek"
  | "recovery_code_entry"
  | "rotate_after_recover"
  | "done";

export interface PassphraseFlowPlan {
  mode: PassphraseFlowMode;
  steps: PassphraseFlowStep[];
  warnings: PassphraseFlowWarning[];
  /** When mode === "unlock", how many failed attempts remain before
   * the operation locks for the configured cooldown. */
  attemptsRemaining: number | null;
  /** When the entry is locked, ms timestamp at which next attempt is
   * allowed. null when not in lockout. */
  lockedUntilMs: number | null;
}

export type PassphraseFlowWarning =
  | "no_passphrase_enrolled"
  | "weak_passphrase_strength"
  | "lockout_active"
  | "near_lockout";

export interface PlanPassphraseFlowOptions {
  mode: PassphraseFlowMode;
  /** Whether the user already enrolled a passphrase (presence of
   * SecretStorage entry + envelope blob). */
  hasEnrolledPassphrase: boolean;
  /** Strength score (0..1) returned by zxcvbn-like estimator. Caller
   * supplies it on enroll only. */
  strengthScore?: number;
  /** Past failed unlock attempts within the lockout window. */
  recentFailedAttempts?: number;
  /** Failed attempts before lockout activates. Default 5. */
  maxAttempts?: number;
  /** ms timestamp the lockout started. null when not locked. */
  lockoutStartedAtMs?: number | null;
  /** ms — how long lockout lasts. Default 5 min. */
  lockoutDurationMs?: number;
  /** ms — caller "now". */
  nowMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_DURATION_MS = 5 * 60_000;
const WEAK_STRENGTH_THRESHOLD = 0.5;

export function planPassphraseFlow(options: PlanPassphraseFlowOptions): PassphraseFlowPlan {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const lockoutDuration = options.lockoutDurationMs ?? DEFAULT_LOCKOUT_DURATION_MS;
  const recentFails = options.recentFailedAttempts ?? 0;
  const lockoutStarted = options.lockoutStartedAtMs ?? null;

  const lockedUntilMs = computeLockoutEnd(lockoutStarted, lockoutDuration, options.nowMs);
  const attemptsRemaining =
    options.mode === "unlock" ? Math.max(0, maxAttempts - recentFails) : null;

  const warnings: PassphraseFlowWarning[] = [];
  if (options.mode === "unlock" && !options.hasEnrolledPassphrase) {
    warnings.push("no_passphrase_enrolled");
  }
  if (options.mode === "enroll" && options.strengthScore !== undefined) {
    if (options.strengthScore < WEAK_STRENGTH_THRESHOLD) {
      warnings.push("weak_passphrase_strength");
    }
  }
  if (lockedUntilMs !== null) warnings.push("lockout_active");
  if (
    options.mode === "unlock" &&
    lockedUntilMs === null &&
    attemptsRemaining !== null &&
    attemptsRemaining <= 1 &&
    attemptsRemaining > 0
  ) {
    warnings.push("near_lockout");
  }

  const steps = buildSteps(options.mode, lockedUntilMs !== null);

  return { mode: options.mode, steps, warnings, attemptsRemaining, lockedUntilMs };
}

function computeLockoutEnd(
  lockoutStartedAtMs: number | null,
  durationMs: number,
  nowMs: number,
): number | null {
  if (lockoutStartedAtMs === null) return null;
  const end = lockoutStartedAtMs + durationMs;
  if (end <= nowMs) return null;
  return end;
}

function buildSteps(mode: PassphraseFlowMode, locked: boolean): PassphraseFlowStep[] {
  // Once locked, no operation should proceed past the intro screen.
  if (locked) return ["intro", "done"];
  switch (mode) {
    case "enroll":
      return [
        "intro",
        "passphrase_strength_check",
        "confirm_passphrase",
        "derive_kek",
        "wrap_dek",
        "done",
      ];
    case "unlock":
      return ["intro", "derive_kek", "unwrap_dek", "done"];
    case "recover":
      return [
        "intro",
        "recovery_code_entry",
        "derive_kek",
        "unwrap_dek",
        "rotate_after_recover",
        "done",
      ];
  }
}
