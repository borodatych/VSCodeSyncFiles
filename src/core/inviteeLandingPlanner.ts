/**
 * v3.K — pure decision helper for what the invitee VS Code window should do
 * when a share-link `vscode://...` URI fires `registerUriHandler`.
 *
 * Inputs come from `parseShareLink` (URL contents) plus the local invitee
 * state (do they already have this workspace mounted? have they entered a
 * password yet?). Output is a discriminated action that the UI layer maps
 * to webview prompts / mounting code paths.
 *
 * No `vscode` import. The actual provider read + decryption + mount lives
 * one layer up.
 */

import { verifySnapshotShareACL, type ShareLinkInput } from "./shareLink.js";
import type { SnapshotShareACL } from "./cloudLayout.js";

export type InviteeLandingAction =
  | { kind: "reject_expired"; message: string }
  | { kind: "reject_unknown_workspace"; message: string }
  | { kind: "reject_bad_password"; message: string; attemptsRemaining: number }
  | { kind: "show_password_prompt"; message: string }
  | { kind: "mount_readonly"; workspaceId: string; snapshotName: string };

export interface InviteeLandingInput {
  /** Output of `parseShareLink(raw, now)` — caller has already validated
   * URL shape + non-expired link query param. */
  parsed: ShareLinkInput;
  /** ms — caller "now". */
  nowMs: number;
  /** Whether the invitee has the target workspace mounted locally already.
   * Drives `reject_unknown_workspace` when false (the share is irrelevant
   * unless we can resolve it). */
  hasMatchingWorkspace: boolean;
  /** SnapshotShareACL fetched from cloud `_meta.json`. null when not yet
   * loaded (caller should re-invoke after fetch). */
  cloudAcl: SnapshotShareACL | null;
  /** SHA-256 hex of password the user typed in the password modal. null
   * until the user typed it. Drives the show_password_prompt branch. */
  suppliedPwdHashHex?: string | null;
  /** Failed password attempts so far. */
  recentFailedAttempts?: number;
  /** Cap before refusing further attempts (default 5). */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

export function planInviteeLanding(input: InviteeLandingInput): InviteeLandingAction {
  if (!input.hasMatchingWorkspace) {
    return {
      kind: "reject_unknown_workspace",
      message:
        "This share link points to a workspace that is not mounted on this machine. Connect to the workspace first, then re-open the link.",
    };
  }
  if (input.cloudAcl === null) {
    // Treat null ACL as "could not enforce" — this includes missing
    // SnapshotMeta.sharedTo and provider read failures. Bail with the
    // expired message rather than mount unprotected content.
    return {
      kind: "reject_expired",
      message: "This share link has expired or its access record is missing.",
    };
  }
  // Quick TTL check using the parsed query param when available.
  if (
    input.parsed.expiresAtMs !== undefined &&
    input.nowMs > input.parsed.expiresAtMs
  ) {
    return {
      kind: "reject_expired",
      message: "This share link has expired.",
    };
  }

  // No password attempted yet → ask the user.
  if (
    input.suppliedPwdHashHex === undefined ||
    input.suppliedPwdHashHex === null ||
    input.suppliedPwdHashHex.length === 0
  ) {
    return {
      kind: "show_password_prompt",
      message: "Enter the share password to continue.",
    };
  }

  const verdict = verifySnapshotShareACL(input.cloudAcl, input.suppliedPwdHashHex, input.nowMs);
  if (verdict.ok) {
    return {
      kind: "mount_readonly",
      workspaceId: input.parsed.workspaceId,
      snapshotName: input.parsed.snapshotName,
    };
  }
  if (verdict.reason === "expired") {
    return {
      kind: "reject_expired",
      message: "This share link has expired.",
    };
  }
  // wrong_password OR missing_acl post-fetch (treated the same: user must
  // try again).
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const used = input.recentFailedAttempts ?? 0;
  const remaining = Math.max(0, maxAttempts - used - 1);
  return {
    kind: "reject_bad_password",
    message:
      remaining > 0
        ? `Incorrect password — ${String(remaining)} attempt(s) remaining.`
        : "Incorrect password — no attempts remaining.",
    attemptsRemaining: remaining,
  };
}
