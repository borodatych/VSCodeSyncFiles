/**
 * v2.20.4 — per-provider OAuth 2.1 Pushed-Authorization-Request endpoint
 * configuration.
 *
 * Pairs with `src/core/oauthPushedAuthRequest.ts`. Each provider declares
 * its `pushed_authorization_request_endpoint` URL (or `null` if PAR is not
 * supported). The wiring layer consults this map before the PKCE flow:
 *
 *   - PAR endpoint set → POST request body to it, take `request_uri`,
 *     redirect user to authorize endpoint with only `client_id` +
 *     `request_uri`.
 *   - PAR endpoint null → fall back to standard front-channel PKCE.
 *
 * As of 2026-05-09 none of the four supported providers have published
 * a PAR endpoint. Microsoft Identity (CIAM tenants) and Google CIBA have
 * roadmap entries but haven't shipped to the consumer endpoints we use.
 */
import type { ParRequestParams } from "./oauthPushedAuthRequest.js";

export type OAuthProviderId = "onedrive" | "gdrive" | "dropbox" | "yandex";

export interface ParProviderConfig {
  readonly id: OAuthProviderId;
  /** Endpoint URL, or `null` if the provider does not advertise PAR. */
  readonly parEndpointUrl: string | null;
  /** When set, body builder copies these as `extra` params. */
  readonly extraParams?: Readonly<Record<string, string>>;
  /** Reason `parEndpointUrl: null` — surfaces in diagnostics. */
  readonly unavailableReason?: string;
}

export const PAR_PROVIDER_REGISTRY: readonly ParProviderConfig[] = [
  {
    id: "onedrive",
    parEndpointUrl: null,
    unavailableReason: "Microsoft Identity consumer tenant не публикует PAR endpoint в OIDC discovery.",
  },
  {
    id: "gdrive",
    parEndpointUrl: null,
    unavailableReason: "Google не поддерживает RFC 9126 PAR на OAuth 2.0 endpoints.",
  },
  {
    id: "dropbox",
    parEndpointUrl: null,
    unavailableReason: "Dropbox OAuth 2 не поддерживает PAR.",
  },
  {
    id: "yandex",
    parEndpointUrl: null,
    unavailableReason: "Яндекс.OAuth не поддерживает PAR.",
  },
];

export function getParProviderConfig(id: OAuthProviderId): ParProviderConfig | undefined {
  return PAR_PROVIDER_REGISTRY.find((p) => p.id === id);
}

export function isParAvailableFor(id: OAuthProviderId): boolean {
  return getParProviderConfig(id)?.parEndpointUrl !== null;
}

/** Helper: when caller wants to extend ParRequestParams with provider's
 *  `extraParams` (audience, resource, etc) — non-mutating merge. */
export function extendParParamsForProvider(
  base: ParRequestParams,
  providerId: OAuthProviderId,
): ParRequestParams {
  const cfg = getParProviderConfig(providerId);
  if (!cfg?.extraParams) return base;
  return { ...base, extra: { ...(base.extra ?? {}), ...cfg.extraParams } };
}
