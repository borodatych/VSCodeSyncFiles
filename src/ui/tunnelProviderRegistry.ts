/**
 * Tunnel-provider abstraction for the webhook receive path.
 *
 * v1 transport is smee.io (`webhookTunnel.ts`). v2 plans:
 *   - cloudflared (Cloudflare Quick Tunnel via `cloudflared` CLI)
 *   - tailscale-funnel (`tailscale funnel <port>` for tailnet users)
 *
 * This module defines the contract and the registry. The actual cloudflared /
 * tailscale backends are skeletons — they validate prerequisites and fall back
 * to a clear error message when the binary is missing. Callers should fall
 * through to smee on `not_available`.
 */
import { warnLog } from "../utils/log.js";

export type TunnelProviderType = "smee" | "cloudflared" | "tailscale-funnel";

export interface TunnelChannel {
  /** Public URL where webhooks should be POSTed. */
  publicUrl: string;
  /** Backend that produced this channel — for telemetry / status display. */
  provider: TunnelProviderType;
  /** Stop the tunnel and free the port. Idempotent. */
  dispose(): Promise<void>;
}

export type TunnelOpenResult =
  | { ok: true; channel: TunnelChannel }
  | { ok: false; reason: "not_available" | "config_invalid" | "spawn_failed"; detail?: string };

export interface TunnelBackend {
  readonly type: TunnelProviderType;
  /**
   * Open a tunnel to the given local port. Returns either a live channel or
   * an explicit reason string the UI can route on.
   */
  open(localPort: number, signal?: AbortSignal): Promise<TunnelOpenResult>;
}

const backends = new Map<TunnelProviderType, TunnelBackend>();

export function registerTunnelBackend(b: TunnelBackend): void {
  backends.set(b.type, b);
}

export function listTunnelBackends(): TunnelProviderType[] {
  return [...backends.keys()];
}

/**
 * Open a tunnel using the requested backend. Caller is expected to fall back
 * to smee.io on `not_available`. Unknown / unregistered backends short-circuit
 * to a `not_available` reason without throwing — the setting may name a
 * future provider that this build hasn't shipped yet.
 */
export async function openTunnel(
  type: TunnelProviderType,
  localPort: number,
  signal?: AbortSignal,
): Promise<TunnelOpenResult> {
  const b = backends.get(type);
  if (!b) {
    warnLog("tunnel", `backend "${type}" is not registered in this build`);
    return { ok: false, reason: "not_available", detail: `backend "${type}" not registered` };
  }
  return b.open(localPort, signal);
}

/**
 * Map raw setting value to a known backend. Empty / invalid → smee (default).
 */
export function resolveTunnelType(raw: string | undefined): TunnelProviderType {
  if (raw === "cloudflared" || raw === "tailscale-funnel" || raw === "smee") return raw;
  return "smee";
}
