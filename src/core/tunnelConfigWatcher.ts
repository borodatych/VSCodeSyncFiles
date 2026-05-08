/**
 * v2.4.5 — pure decision helper for tunnel auto-restart.
 *
 * Caller subscribes to `vscode.workspace.onDidChangeConfiguration` and reads
 * the relevant settings; this module decides whether the tunnel relay needs
 * to be torn down and recreated.
 *
 * Triggers:
 *   - tunnel provider changed (e.g. smee → cloudflared).
 *   - webhook URL changed (the user wants notifications elsewhere).
 *   - tunnel was disabled.
 *
 * No `vscode` import.
 */
import type { TunnelProviderType } from "../ui/tunnelProviderRegistry.js";

export interface TunnelConfigSnapshot {
  /** Raw `vscodesync.webhooks.tunnelProvider` value. */
  rawProvider: string | undefined;
  /** Resolved provider type. */
  resolved: TunnelProviderType;
  /** vscodesync.webhooks.tunnelEnabled. */
  enabled: boolean;
  /** Optional user-supplied URL override (vscodesync.webhooks.url). */
  url: string | undefined;
}

export type TunnelConfigChangeAction =
  | { action: "no_change" }
  | { action: "restart"; reason: string }
  | { action: "stop"; reason: string }
  | { action: "start"; reason: string };

export function compareTunnelConfig(
  prev: TunnelConfigSnapshot | null,
  next: TunnelConfigSnapshot,
): TunnelConfigChangeAction {
  if (prev === null) {
    return next.enabled ? { action: "start", reason: "first_activation" } : { action: "no_change" };
  }
  if (prev.enabled && !next.enabled) {
    return { action: "stop", reason: "tunnel_disabled" };
  }
  if (!prev.enabled && next.enabled) {
    return { action: "start", reason: "tunnel_enabled" };
  }
  if (!next.enabled) return { action: "no_change" };
  if (prev.resolved !== next.resolved) {
    return {
      action: "restart",
      reason: `provider_changed:${prev.resolved}→${next.resolved}`,
    };
  }
  if ((prev.url ?? "") !== (next.url ?? "")) {
    return { action: "restart", reason: "url_changed" };
  }
  return { action: "no_change" };
}
