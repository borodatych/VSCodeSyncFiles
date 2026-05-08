/**
 * v2.10.1 — strict envelope decoders for Microsoft Graph subscription
 * responses (`POST /v1.0/subscriptions`, `PATCH /v1.0/subscriptions/{id}`).
 *
 * Today the lifecycle wrapper does an unsafe cast:
 *
 *   const j = JSON.parse(t) as { id?: string; expirationDateTime?: string };
 *
 * That accepts anything JSON-shaped — including arrays, partial responses,
 * or nested error envelopes — and only fails on the next-line guard. With
 * a strict decoder the wrapper can route bad payloads explicitly into a
 * "graph_response_invalid" branch instead of producing a vague Error.
 *
 * No `vscode`, no IO. Round-trip with the real Graph response shape lives
 * in `graphWebhookSubscription.ts`.
 */

export interface GraphSubscriptionEnvelope {
  id: string;
  expirationDateTime: string;
}

export type GraphSubscriptionDecodeResult =
  | { ok: true; value: GraphSubscriptionEnvelope }
  | { ok: false; reason: GraphSubscriptionDecodeRejection };

export type GraphSubscriptionDecodeRejection =
  | "not_object"
  | "missing_id"
  | "missing_expiration"
  | "bad_id_type"
  | "bad_expiration_type"
  | "bad_expiration_format";

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Decode the body of a Graph create / renew subscription response. */
export function decodeGraphSubscriptionEnvelope(
  json: unknown,
): GraphSubscriptionDecodeResult {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "not_object" };
  }
  const obj = json as Record<string, unknown>;
  if (!("id" in obj)) return { ok: false, reason: "missing_id" };
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return { ok: false, reason: "bad_id_type" };
  }
  if (!("expirationDateTime" in obj)) {
    return { ok: false, reason: "missing_expiration" };
  }
  if (typeof obj.expirationDateTime !== "string" || obj.expirationDateTime.length === 0) {
    return { ok: false, reason: "bad_expiration_type" };
  }
  if (!ISO_8601_RE.test(obj.expirationDateTime)) {
    return { ok: false, reason: "bad_expiration_format" };
  }
  // Date.parse final guard: ISO regex accepts e.g. "2026-13-40T..." that the
  // parser rejects. We treat that as bad_expiration_format too.
  if (Number.isNaN(Date.parse(obj.expirationDateTime))) {
    return { ok: false, reason: "bad_expiration_format" };
  }
  return {
    ok: true,
    value: { id: obj.id, expirationDateTime: obj.expirationDateTime },
  };
}

/** Decode a renew response, where Graph may omit the new expiration if it
 *  decided to keep the existing one. The caller supplies a fallback. */
export function decodeGraphRenewExpiration(
  json: unknown,
  fallbackExpiration: string,
): { ok: true; expirationDateTime: string } | { ok: false; reason: "not_object" | "bad_expiration_type" | "bad_expiration_format" } {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "not_object" };
  }
  const obj = json as Record<string, unknown>;
  if (!("expirationDateTime" in obj) || obj.expirationDateTime === undefined) {
    return { ok: true, expirationDateTime: fallbackExpiration };
  }
  if (typeof obj.expirationDateTime !== "string" || obj.expirationDateTime.length === 0) {
    return { ok: false, reason: "bad_expiration_type" };
  }
  if (!ISO_8601_RE.test(obj.expirationDateTime) || Number.isNaN(Date.parse(obj.expirationDateTime))) {
    return { ok: false, reason: "bad_expiration_format" };
  }
  return { ok: true, expirationDateTime: obj.expirationDateTime };
}
