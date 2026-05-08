/**
 * v2.2.6 — pure WebAuthn envelope wrap/unwrap with a *mock* derive function.
 *
 * Real `navigator.credentials.create / get` is not available in Node /
 * vitest, so this module accepts a `deriveKek(credentialId, salt)` injection.
 * The wrapper then:
 *   1. AES-256-GCM encrypts the raw DEK under the derived KEK.
 *   2. Stores the ciphertext + iv + authTag + credentialId in a
 *      `KeyEnvelope` of `source: "webauthn"`.
 *   3. The production code path will plug in a real
 *      `navigator.credentials.get(...).getClientExtensionResults().prf`
 *      derive function — same shape, this module already verifies the
 *      round-trip on a deterministic mock derive.
 *
 * No `vscode` import. The auth tag is appended to the ciphertext (last 16
 * bytes) so the existing `KeyEnvelope` shape (cipherB64) does not need a new
 * field.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  bytesToB64,
  b64ToBytes,
  type KeyEnvelope,
} from "./keyEnvelope.js";

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type DeriveKekFn = (credentialId: string, salt: Uint8Array) => Uint8Array;

export function wrapDekForWebauthn(
  rawDek: Uint8Array,
  credentialId: string,
  derive: DeriveKekFn,
): KeyEnvelope {
  if (rawDek.length !== AES_KEY_BYTES) {
    throw new Error(`wrapDekForWebauthn: DEK must be ${String(AES_KEY_BYTES)} bytes`);
  }
  const salt = randomBytes(16);
  const kek = derive(credentialId, salt);
  if (kek.length !== AES_KEY_BYTES) {
    throw new Error("wrapDekForWebauthn: derive returned a KEK of wrong size");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(rawDek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Append authTag to ciphertext to keep the existing KeyEnvelope shape.
  const cipherWithTag = Buffer.concat([ciphertext, authTag]);
  return {
    v: 1,
    source: "webauthn",
    ivB64: bytesToB64(iv),
    cipherB64: bytesToB64(cipherWithTag),
    saltB64: bytesToB64(salt),
    meta: { credentialId },
  };
}

export type UnwrapResult =
  | { ok: true; rawDek: Uint8Array }
  | { ok: false; reason: "shape" | "auth_failure" };

export function unwrapDekFromWebauthn(
  envelope: KeyEnvelope,
  derive: DeriveKekFn,
): UnwrapResult {
  if (envelope.source !== "webauthn") return { ok: false, reason: "shape" };
  const credentialId = envelope.meta?.credentialId;
  if (typeof credentialId !== "string" || credentialId.length === 0) {
    return { ok: false, reason: "shape" };
  }
  if (envelope.saltB64 === undefined || envelope.saltB64.length === 0) {
    return { ok: false, reason: "shape" };
  }
  let salt: Uint8Array;
  let iv: Uint8Array;
  let cipherWithTag: Uint8Array;
  try {
    salt = b64ToBytes(envelope.saltB64);
    iv = b64ToBytes(envelope.ivB64);
    cipherWithTag = b64ToBytes(envelope.cipherB64);
  } catch {
    return { ok: false, reason: "shape" };
  }
  if (cipherWithTag.length < AUTH_TAG_BYTES) return { ok: false, reason: "shape" };
  const ct = cipherWithTag.subarray(0, cipherWithTag.length - AUTH_TAG_BYTES);
  const authTag = cipherWithTag.subarray(cipherWithTag.length - AUTH_TAG_BYTES);
  const kek = derive(credentialId, salt);
  if (kek.length !== AES_KEY_BYTES) return { ok: false, reason: "shape" };
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAuthTag(authTag);
  try {
    const dek = Buffer.concat([decipher.update(ct), decipher.final()]);
    return { ok: true, rawDek: new Uint8Array(dek) };
  } catch {
    return { ok: false, reason: "auth_failure" };
  }
}
