/**
 * v2.20.4 — OAuth 2.1 Pushed Authorization Request (PAR, RFC 9126) helpers.
 *
 * Plain OAuth + PKCE puts every authorisation parameter (scope, redirect_uri,
 * code_challenge, etc) in the URL the browser navigates to. PAR moves all of
 * these into a back-channel POST to a `pushed_authorization_request_endpoint`
 * which returns an opaque `request_uri`; the front-channel URL then carries
 * only `client_id` + `request_uri`. This blocks parameter tampering and
 * shrinks the URL — both helpful for FAPI 2 / corporate OAuth servers.
 *
 * This module is a *pure planner*:
 *   - `buildParRequestBody(params)` → `application/x-www-form-urlencoded`
 *     body for the back-channel POST.
 *   - `parseParResponse(json)` → strict decoder that surfaces `request_uri`
 *     + `expires_in` or a typed `bad_response` reason.
 *   - `buildAuthorizeUrlWithRequestUri(params)` → final front-channel URL.
 *
 * No fetch / no provider config — wiring layer (per provider) decides
 * whether it speaks PAR. Existing PKCE flow remains the default.
 */

export interface ParRequestParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly responseType: "code"; // OAuth 2.1 only ships authorization-code
  readonly scope: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  /** Optional `audience` hint, etc. */
  readonly extra?: Readonly<Record<string, string>>;
}

export function buildParRequestBody(params: ParRequestParams): string {
  const usp = new URLSearchParams();
  usp.set("client_id", params.clientId);
  usp.set("redirect_uri", params.redirectUri);
  usp.set("response_type", params.responseType);
  usp.set("scope", params.scope);
  usp.set("state", params.state);
  usp.set("code_challenge", params.codeChallenge);
  usp.set("code_challenge_method", params.codeChallengeMethod);
  if (params.extra) {
    for (const [k, v] of Object.entries(params.extra)) usp.set(k, v);
  }
  return usp.toString();
}

export interface ParResponseOk {
  readonly ok: true;
  readonly requestUri: string;
  readonly expiresInSec: number;
}

export interface ParResponseErr {
  readonly ok: false;
  readonly reason:
    | "bad_response"
    | "missing_request_uri"
    | "missing_expires_in"
    | "rfc6749_error";
  readonly oauthError?: { error: string; description?: string };
}

export type ParResponse = ParResponseOk | ParResponseErr;

export function parseParResponse(input: unknown): ParResponse {
  if (input === null || typeof input !== "object") return { ok: false, reason: "bad_response" };
  const obj = input as Record<string, unknown>;
  if (typeof obj.error === "string") {
    return {
      ok: false,
      reason: "rfc6749_error",
      oauthError: {
        error: obj.error,
        description: typeof obj.error_description === "string" ? obj.error_description : undefined,
      },
    };
  }
  if (typeof obj.request_uri !== "string" || obj.request_uri.length === 0) {
    return { ok: false, reason: "missing_request_uri" };
  }
  if (typeof obj.expires_in !== "number" || !Number.isFinite(obj.expires_in)) {
    return { ok: false, reason: "missing_expires_in" };
  }
  return { ok: true, requestUri: obj.request_uri, expiresInSec: obj.expires_in };
}

export interface AuthorizeUrlParams {
  readonly authorizeEndpoint: string;
  readonly clientId: string;
  readonly requestUri: string;
}

export function buildAuthorizeUrlWithRequestUri(p: AuthorizeUrlParams): string {
  const u = new URL(p.authorizeEndpoint);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("request_uri", p.requestUri);
  return u.toString();
}

export class ParEndpointNotConfiguredError extends Error {
  readonly code = "par_endpoint_not_configured" as const;
  constructor(message?: string) {
    super(
      message ??
        "Pushed Authorization Request endpoint is not configured for this provider " +
          "(v2.20.4 in roadmap). Existing PKCE-only flow remains in effect.",
    );
    this.name = "ParEndpointNotConfiguredError";
  }
}
