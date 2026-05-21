/**
 * M4 — Passkey-only mode — pure decision module.
 *
 * Skeleton: given the current registered passkeys and the passphrase-
 * fallback policy, decide whether the user is allowed to use the
 * passphrase fallback at all. When `passkeyOnly` is on AND at least
 * one passkey is registered, passphrase unlock is rejected.
 *
 * Pure module — no vscode, no keytar.
 */

export interface PasskeyOnlyInput {
  /** User setting `vscodesync.passkeyOnly` (default off). */
  passkeyOnly: boolean;
  /** Whether at least one passkey credential exists in the registry. */
  hasRegisteredPasskey: boolean;
}

export type PasskeyAllowance =
  | { kind: "allow_passphrase"; reason: "passkey_only_off" | "no_passkey_registered" }
  | { kind: "deny_passphrase"; reason: "passkey_only_on" };

export function decidePassphraseAllowance(input: PasskeyOnlyInput): PasskeyAllowance {
  if (!input.passkeyOnly) {
    return { kind: "allow_passphrase", reason: "passkey_only_off" };
  }
  if (!input.hasRegisteredPasskey) {
    // Don't lock the user out: passkey-only with zero passkeys is a misconfiguration.
    return { kind: "allow_passphrase", reason: "no_passkey_registered" };
  }
  return { kind: "deny_passphrase", reason: "passkey_only_on" };
}

/** Sentinel: thrown by wiring when passphrase fallback is invoked while
 *  `decidePassphraseAllowance` returned `deny_passphrase`. */
export class PassphraseDeniedByPasskeyOnlyError extends Error {
  constructor() {
    super("Passphrase unlock denied: vscodesync.passkeyOnly = true");
    this.name = "PassphraseDeniedByPasskeyOnlyError";
  }
}
