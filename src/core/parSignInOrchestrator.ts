/**
 * v2.20.4 — PAR-aware sign-in orchestrator (skeleton).
 *
 * Glue layer that combines the pure planner `oauthPushedAuthRequest.ts`
 * with the per-provider config `parProviderRegistry.ts`. When a provider
 * does declare its `pushed_authorization_request_endpoint`:
 *
 *   1. POST `buildParRequestBody(...)` to the endpoint.
 *   2. `parseParResponse(...)` → `request_uri` + `expires_in`.
 *   3. `buildAuthorizeUrlWithRequestUri(...)` → final front-channel URL.
 *   4. Hand off to existing PKCE callback handler.
 *
 * Today every provider has `parEndpointUrl: null`, so the orchestrator
 * always falls back to plain PKCE (no PAR step). The path returns a
 * discriminated result the caller routes:
 *
 *   - `{ kind: "par_used"; authorizeUrl }` — PAR succeeded, browse here.
 *   - `{ kind: "fallback_to_pkce" }` — provider doesn't speak PAR yet.
 *   - `{ kind: "error"; reason }` — PAR endpoint declared but failed.
 *
 * Caller stays oblivious to whether PAR fired; existing PKCE path always
 * runs after the front-channel URL is opened.
 */
import {
  buildAuthorizeUrlWithRequestUri,
  buildParRequestBody,
  parseParResponse,
  type ParRequestParams,
} from "./oauthPushedAuthRequest.js";
import {
  extendParParamsForProvider,
  getParProviderConfig,
  type OAuthProviderId,
} from "./parProviderRegistry.js";

export type ParOrchestrationResult =
  | { kind: "par_used"; authorizeUrl: string; expiresInSec: number }
  | { kind: "fallback_to_pkce" }
  | { kind: "error"; reason: ParOrchestrationError; detail?: string };

export type ParOrchestrationError =
  | "par_endpoint_unreachable"
  | "par_response_rejected"
  | "rfc6749_error";

export interface RunParThenAuthorizeInput {
  readonly providerId: OAuthProviderId;
  readonly authorizeEndpoint: string;
  readonly params: ParRequestParams;
  /** Inject a fetch for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export async function runParThenAuthorize(
  input: RunParThenAuthorizeInput,
): Promise<ParOrchestrationResult> {
  const endpoint = getParProviderConfig(input.providerId)?.parEndpointUrl;
  if (endpoint === null || endpoint === undefined) {
    return { kind: "fallback_to_pkce" };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const params = extendParParamsForProvider(input.params, input.providerId);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: buildParRequestBody(params),
    });
  } catch (e) {
    return {
      kind: "error",
      reason: "par_endpoint_unreachable",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (e) {
    return {
      kind: "error",
      reason: "par_response_rejected",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  const parsed = parseParResponse(json);
  if (!parsed.ok) {
    if (parsed.reason === "rfc6749_error") {
      return {
        kind: "error",
        reason: "rfc6749_error",
        detail: parsed.oauthError?.error ?? "unknown_oauth_error",
      };
    }
    return { kind: "error", reason: "par_response_rejected", detail: parsed.reason };
  }
  const authorizeUrl = buildAuthorizeUrlWithRequestUri({
    authorizeEndpoint: input.authorizeEndpoint,
    clientId: input.params.clientId,
    requestUri: parsed.requestUri,
  });
  return { kind: "par_used", authorizeUrl, expiresInSec: parsed.expiresInSec };
}
