/**
 * @experimental v2.2 Passkey/WebAuthn KEK skeleton — wired in v2.x.
 * Keep until the full envelope path lands; do NOT delete as "dead code".
 *
 * Key envelope helpers (v2.2 — Passkey/WebAuthn KEK skeleton).
 *
 * The current encryption layer keeps the AES-256 DEK directly in
 * SecretStorage. Compromising the OS = exposing every workspace at once.
 *
 * The envelope wraps DEK in a KEK derived from one of three sources:
 *   - `passphrase`: PBKDF2(SHA-256, 200 000 iters) over user passphrase
 *   - `webauthn`:   future — extracts PRF from a registered credential
 *   - `none`:       backward-compat marker (DEK stored as-is)
 *
 * This module exposes only the *envelope* shape and the passphrase code path.
 * The webauthn path requires `navigator.credentials` (web) or a native FIDO2
 * binding (desktop) and is intentionally left as a skeleton: helpers throw
 * `not_implemented` so the wiring fails closed instead of silently degrading.
 *
 * vscode-free: covered by unit tests; encryption itself stays in
 * `core/encryption.ts` with the existing AES-256-GCM pipeline.
 */

export type KekSource = "none" | "passphrase" | "webauthn";

/** Stored in SecretStorage instead of the raw DEK once enrollment is done. */
export interface KeyEnvelope {
  /** Schema version of the envelope (bump when wire shape changes). */
  v: 1;
  source: KekSource;
  /** Base64 IV used by AES-GCM when `source !== "none"`. Empty for "none". */
  ivB64: string;
  /** Base64 ciphertext (DEK encrypted under KEK). For "none" — raw DEK base64. */
  cipherB64: string;
  /** Base64 PBKDF2 salt; only used when `source === "passphrase"`. */
  saltB64?: string;
  /** Iteration count for the passphrase KDF; only valid when `source === "passphrase"`. */
  iterations?: number;
  /** Free-form metadata for the source — e.g. WebAuthn credentialID base64url. */
  meta?: Record<string, string>;
}

export const PBKDF2_ITERATIONS = 200_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const KEY_BITS = 256;

export function isKeyEnvelope(x: unknown): x is KeyEnvelope {
  if (x === null || typeof x !== "object") return false;
  const e = x as Partial<KeyEnvelope>;
  if (e.v !== 1) return false;
  if (e.source !== "none" && e.source !== "passphrase" && e.source !== "webauthn") return false;
  if (typeof e.ivB64 !== "string" || typeof e.cipherB64 !== "string") return false;
  if (e.source === "passphrase") {
    if (typeof e.saltB64 !== "string") return false;
    if (typeof e.iterations !== "number" || !Number.isFinite(e.iterations) || e.iterations < 10_000) {
      return false;
    }
  }
  return true;
}

/**
 * Build an envelope for the «no extra wrap» mode — used as a backward-compat
 * write path (existing users who haven't enrolled passphrase / passkey yet).
 */
export function envelopeNoneFromRawKey(rawDek: Uint8Array): KeyEnvelope {
  return {
    v: 1,
    source: "none",
    ivB64: "",
    cipherB64: bytesToB64(rawDek),
  };
}

/** Reverse of `envelopeNoneFromRawKey`. Returns the raw DEK or null on shape mismatch. */
export function rawKeyFromNoneEnvelope(env: KeyEnvelope): Uint8Array | null {
  if (env.source !== "none") return null;
  return b64ToBytes(env.cipherB64);
}

// ─── base64 helpers (works in Node + browser) ────────────────────────────────

export function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  // btoa is part of WebWorker lib; available in Node 16+ and browsers.
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < out.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Constant-time compare for envelope-related secrets (KEK match-checks). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i] ^ b[i];
  return acc === 0;
}

/**
 * Sentinel error for the WebAuthn code paths that aren't wired up yet. The
 * UI catches this specifically and points the user to the Passkey roadmap.
 */
export class KeyEnvelopeNotImplementedError extends Error {
  constructor(reason: string) {
    super(`KeyEnvelope: ${reason} (v2.2 in roadmap)`);
    this.name = "KeyEnvelopeNotImplementedError";
  }
}

/**
 * v2.2.1 — derive a 32-byte KEK from the PRF extension output returned by
 * the authenticator. The PRF result is already 32 bytes of pseudo-random
 * material bound to the credential, so we just ingest it through HKDF with
 * a salt tied to the envelope to support multi-DEK scenarios.
 *
 * `prfOutput` must be the raw 32-byte PRF.eval.first result. `salt` should
 * be the random-per-envelope salt (re-used between enroll and unlock).
 *
 * No vscode import — pure node:crypto path. Browser builds get the same
 * surface via subtle.deriveKey wiring (out of scope for this module).
 */
export function deriveWebauthnKek(
  prfOutput: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array = new TextEncoder().encode("vscodesync-webauthn-kek-v1"),
): Uint8Array {
  if (prfOutput.length < 32) {
    throw new Error(`webauthn PRF output too short (${String(prfOutput.length)} < 32 bytes)`);
  }
  // HKDF: extract → expand. Single-block expand suffices for 32-byte output.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const prk = crypto.createHmac("sha256", Buffer.from(salt)).update(Buffer.from(prfOutput)).digest();
  const t1 = crypto.createHmac("sha256", prk).update(Buffer.concat([Buffer.from(info), Buffer.from([0x01])])).digest();
  return new Uint8Array(t1);
}
