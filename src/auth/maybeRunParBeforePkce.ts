/**
 * v2.20.4 — PAR auto-activate hook for provider sign-in flows.
 *
 * Existing OAuth/PKCE flows (`onedrive`, `gdrive`, `dropbox`, `yandex`)
 * build their authorize URL inline and open it via `vscode.env.openExternal`.
 * This module is a *forward-stable* hook each flow can call BEFORE building
 * its authorize URL: when the provider's PAR endpoint goes live, the hook
 * silently switches the URL to one carrying `request_uri`, no flow code
 * changes needed.
 *
 * Today every provider's `parEndpointUrl` is `null`, so the hook always
 * returns `null` (== "use your existing flow as-is"). The forward path
 * lights up as soon as `parProviderRegistry.ts` flips an entry to a real
 * URL.
 *
 * vscode-free; one fetch boundary; the orchestrator under the hood is
 * `parSignInOrchestrator.ts:runParThenAuthorize`.
 */
import { runParThenAuthorize } from "../core/parSignInOrchestrator.js";
import type { OAuthProviderId } from "../core/parProviderRegistry.js";
import type { ParRequestParams } from "../core/oauthPushedAuthRequest.js";

export interface MaybeParInput {
  readonly providerId: OAuthProviderId;
  readonly authorizeEndpoint: string;
  readonly params: ParRequestParams;
  /** Test seam — defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type MaybeParResult =
  | { kind: "par_used"; authorizeUrl: string; expiresInSec: number }
  | { kind: "fallback_to_pkce" }
  | { kind: "par_attempted_but_failed"; reason: string; detail?: string };

/**
 * Returns the URL the caller should open (or `kind: "fallback_to_pkce"` for
 * the legacy build-it-yourself path). On `par_attempted_but_failed`, caller
 * may choose to log + fall back to PKCE — PAR is best-effort.
 */
export async function maybeRunParBeforePkce(
  input: MaybeParInput,
): Promise<MaybeParResult> {
  const result = await runParThenAuthorize(input);
  if (result.kind === "par_used") return result;
  if (result.kind === "fallback_to_pkce") return result;
  return {
    kind: "par_attempted_but_failed",
    reason: result.reason,
    detail: result.detail,
  };
}
