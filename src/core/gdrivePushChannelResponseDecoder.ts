/**
 * v2.10.1 — strict envelope decoder for the Google Drive
 * `POST /files/{folderId}/watch` response. Mirror of
 * `graphSubscriptionResponseDecoder.ts` but for the Drive API.
 *
 * Drive returns:
 *   {
 *     "id": "<channel-id>",
 *     "resourceId": "<resource-id>",
 *     "expiration": "<epoch-ms-as-string>"
 *   }
 *
 * `expiration` is an epoch-ms string (NOT ISO-8601, unlike Graph). The
 * decoder verifies it parses to a finite, non-negative integer.
 *
 * No `vscode`, no IO. Caller wraps the live `gdriveStartFolderWatch` and
 * pipes the parsed JSON through this decoder.
 */

export interface GdrivePushChannelEnvelope {
  id: string;
  resourceId: string;
  /** Original epoch-ms string as Drive returned it. */
  expiration: string;
  /** Parsed expiration as a Number (ms since epoch). */
  expirationMs: number;
}

export type GdrivePushChannelDecodeResult =
  | { ok: true; value: GdrivePushChannelEnvelope }
  | { ok: false; reason: GdrivePushChannelDecodeRejection };

export type GdrivePushChannelDecodeRejection =
  | "not_object"
  | "missing_id"
  | "missing_resource_id"
  | "missing_expiration"
  | "bad_id_type"
  | "bad_resource_id_type"
  | "bad_expiration_type"
  | "bad_expiration_format";

const POSITIVE_INT_RE = /^[1-9]\d{0,15}$/;

export function decodeGdrivePushChannelEnvelope(
  json: unknown,
): GdrivePushChannelDecodeResult {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "not_object" };
  }
  const obj = json as Record<string, unknown>;
  if (!("id" in obj)) return { ok: false, reason: "missing_id" };
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return { ok: false, reason: "bad_id_type" };
  }
  if (!("resourceId" in obj)) return { ok: false, reason: "missing_resource_id" };
  if (typeof obj.resourceId !== "string" || obj.resourceId.length === 0) {
    return { ok: false, reason: "bad_resource_id_type" };
  }
  if (!("expiration" in obj)) return { ok: false, reason: "missing_expiration" };
  if (typeof obj.expiration !== "string" || obj.expiration.length === 0) {
    return { ok: false, reason: "bad_expiration_type" };
  }
  if (!POSITIVE_INT_RE.test(obj.expiration)) {
    return { ok: false, reason: "bad_expiration_format" };
  }
  const expirationMs = Number(obj.expiration);
  if (!Number.isFinite(expirationMs) || expirationMs <= 0) {
    return { ok: false, reason: "bad_expiration_format" };
  }
  return {
    ok: true,
    value: {
      id: obj.id,
      resourceId: obj.resourceId,
      expiration: obj.expiration,
      expirationMs,
    },
  };
}

/** Convenience: Drive's `expiration` epoch-ms-string predicate, used in
 *  `webhookExpirationMath.reconcileFromFlags` to compute `withinValidSlack`
 *  / `withinRenewSlack` flags from a raw response. */
export function gdriveExpirationToIso(epochMsString: string): string | null {
  if (!POSITIVE_INT_RE.test(epochMsString)) return null;
  const ms = Number(epochMsString);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}
