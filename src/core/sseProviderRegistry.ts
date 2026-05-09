/**
 * v2.20.4 — per-provider SSE endpoint registry.
 *
 * Pairs with the pure decoder in `src/core/webhookSseDecoder.ts`. Each
 * provider declares whether it speaks SSE and at what URL; the wiring
 * layer iterates this registry on startup and only opens long-lived
 * connections for entries with `available: true` _and_ for which the
 * provider's auth tokens exist.
 *
 * Today every provider's `available` is `false` — none of OneDrive /
 * Google Drive / Dropbox / Yandex.Disk ship a public SSE webhooks-feed.
 * Drive Activity API has a streaming endpoint behind a different scope
 * and is the most likely first wiring target. The registry shape is
 * forward-ready so adding a real connector is one entry, not a refactor.
 */

export type SseProviderId = "onedrive" | "gdrive" | "dropbox" | "yandex";

export interface SseProviderConfig {
  readonly id: SseProviderId;
  readonly available: boolean;
  /** Endpoint URL; empty when `available: false`. */
  readonly endpointUrl: string;
  /** OAuth scope required (extra to the base scope). */
  readonly extraScope?: string;
  /** Reason `available: false` — for diagnostic logging. */
  readonly unavailableReason?: string;
}

export const SSE_PROVIDER_REGISTRY: readonly SseProviderConfig[] = [
  {
    id: "onedrive",
    available: false,
    endpointUrl: "",
    unavailableReason: "Microsoft Graph не предоставляет SSE; webhook-канал остаётся через subscriptions API.",
  },
  {
    id: "gdrive",
    available: false,
    endpointUrl: "",
    extraScope: "https://www.googleapis.com/auth/drive.activity.readonly",
    unavailableReason: "Drive Activity API streaming endpoint требует beta scope; wiring остаётся в TODO.",
  },
  {
    id: "dropbox",
    available: false,
    endpointUrl: "",
    unavailableReason: "Dropbox использует webhook + long-poll; SSE не поддерживается.",
  },
  {
    id: "yandex",
    available: false,
    endpointUrl: "",
    unavailableReason: "Яндекс.Диск API не предоставляет SSE/webhooks.",
  },
];

export function getSseProviderConfig(id: SseProviderId): SseProviderConfig | undefined {
  return SSE_PROVIDER_REGISTRY.find((p) => p.id === id);
}

export function listAvailableSseProviders(): readonly SseProviderConfig[] {
  return SSE_PROVIDER_REGISTRY.filter((p) => p.available);
}

export class SseProviderUnavailableError extends Error {
  readonly code = "sse_provider_unavailable" as const;
  constructor(public readonly providerId: SseProviderId, reason?: string) {
    super(`SSE not available for provider ${providerId}${reason ? `: ${reason}` : ""}`);
    this.name = "SseProviderUnavailableError";
  }
}
