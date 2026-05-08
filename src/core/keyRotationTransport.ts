/**
 * v3.D — pure shape and decoder for the multi-machine key-rotation transport
 * blob written to `_keyrotation/{rotationId}.json`.
 *
 * Why a separate file: when a machine completes (or starts) a rotation, it
 * needs other machines to pick up the new DEK. Each peer reads
 * `_keyrotation/{rotationId}.json`, derives the *old* KEK from its existing
 * envelope, decrypts the inner blob, and learns the new DEK + new envelope.
 *
 * Wire format (JSON):
 *
 *   {
 *     "v": 1,
 *     "rotationId": "<sessionId-ish>",
 *     "fromKeyId": "<sha256 of old DEK | b64>",
 *     "toKeyId":   "<sha256 of new DEK | b64>",
 *     "createdAt": "<ISO>",
 *     "encryptedBlobB64": "<base64 of AES-GCM(oldKEK, newDekJson)>",
 *     "ivB64": "<12-byte IV>",
 *     "authTagB64": "<16-byte authTag>"
 *   }
 *
 * Caller derives the old KEK from its own enrolled envelope, decrypts via
 * AES-GCM, parses the inner JSON to obtain the new DEK + envelope, swaps
 * SecretStorage. This module does not perform crypto — it just defines the
 * envelope and provides a strict decoder.
 */

const ROTATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_ID_RE = /^[A-Za-z0-9+/=_-]{16,128}$/; // base64-ish

export interface KeyRotationTransportEnvelope {
  v: 1;
  rotationId: string;
  fromKeyId: string;
  toKeyId: string;
  createdAt: string;
  encryptedBlobB64: string;
  ivB64: string;
  authTagB64: string;
}

export type KeyRotationTransportDecodeResult =
  | { ok: true; envelope: KeyRotationTransportEnvelope }
  | {
      ok: false;
      reason:
        | "bad_json"
        | "bad_shape"
        | "bad_rotation_id"
        | "bad_key_id"
        | "stale";
    };

export interface DecodeOptions {
  /** Reject envelopes older than `staleAfterMs`. Default 30 days. */
  staleAfterMs?: number;
  now?: number;
}

const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60_000;

/** Cloud path for the rotation blob. */
export function cloudPathForKeyRotation(rotationId: string): string {
  if (!ROTATION_ID_RE.test(rotationId)) {
    throw new Error(`keyRotationTransport: invalid rotationId "${rotationId}"`);
  }
  return `_keyrotation/${rotationId}.json`;
}

export function decodeKeyRotationTransport(
  raw: unknown,
  opts: DecodeOptions = {},
): KeyRotationTransportDecodeResult {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = opts.now ?? Date.now();

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "bad_json" };
    }
  } else if (raw instanceof Uint8Array || (typeof Buffer !== "undefined" && raw instanceof Buffer)) {
    try {
      parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return { ok: false, reason: "bad_json" };
    }
  }
  if (parsed === null || typeof parsed !== "object") return { ok: false, reason: "bad_shape" };

  const e = parsed as Record<string, unknown>;
  if (e.v !== 1) return { ok: false, reason: "bad_shape" };
  if (typeof e.rotationId !== "string") return { ok: false, reason: "bad_rotation_id" };
  if (!ROTATION_ID_RE.test(e.rotationId)) return { ok: false, reason: "bad_rotation_id" };
  if (typeof e.fromKeyId !== "string" || !KEY_ID_RE.test(e.fromKeyId)) {
    return { ok: false, reason: "bad_key_id" };
  }
  if (typeof e.toKeyId !== "string" || !KEY_ID_RE.test(e.toKeyId)) {
    return { ok: false, reason: "bad_key_id" };
  }
  if (typeof e.createdAt !== "string") return { ok: false, reason: "bad_shape" };
  const createdMs = Date.parse(e.createdAt);
  if (Number.isNaN(createdMs)) return { ok: false, reason: "bad_shape" };
  if (now - createdMs > staleAfterMs) return { ok: false, reason: "stale" };
  if (
    typeof e.encryptedBlobB64 !== "string" ||
    typeof e.ivB64 !== "string" ||
    typeof e.authTagB64 !== "string"
  ) {
    return { ok: false, reason: "bad_shape" };
  }

  return { ok: true, envelope: parsed as KeyRotationTransportEnvelope };
}

export function buildKeyRotationTransport(input: {
  rotationId: string;
  fromKeyId: string;
  toKeyId: string;
  encryptedBlobB64: string;
  ivB64: string;
  authTagB64: string;
  createdAtMs?: number;
}): KeyRotationTransportEnvelope {
  if (!ROTATION_ID_RE.test(input.rotationId)) {
    throw new Error(`keyRotationTransport: invalid rotationId "${input.rotationId}"`);
  }
  if (!KEY_ID_RE.test(input.fromKeyId) || !KEY_ID_RE.test(input.toKeyId)) {
    throw new Error("keyRotationTransport: invalid keyId");
  }
  return {
    v: 1,
    rotationId: input.rotationId,
    fromKeyId: input.fromKeyId,
    toKeyId: input.toKeyId,
    createdAt: new Date(input.createdAtMs ?? Date.now()).toISOString(),
    encryptedBlobB64: input.encryptedBlobB64,
    ivB64: input.ivB64,
    authTagB64: input.authTagB64,
  };
}
