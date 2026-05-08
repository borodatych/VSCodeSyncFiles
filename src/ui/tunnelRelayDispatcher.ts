/**
 * v2.4.4 — high-level dispatcher that picks between smee.io SSE relay and a
 * spawn'd tunnel backend (cloudflared / tailscale funnel) depending on the
 * `vscodesync.webhooks.tunnelProvider` setting.
 *
 * Contract:
 *   - `type === "smee"` → returns the existing SSE-pull relay unchanged.
 *   - `type !== "smee"` → starts a local webhook server, opens the tunnel via
 *     `openTunnel`. On `not_available` / `config_invalid` / `spawn_failed`,
 *     gracefully falls back to smee with a logged warning.
 *
 * Caller hands in:
 *   - A `handler` that accepts `SmeePayload` (the existing SSE shape) — for
 *     smee path this is the SSE callback; for tunnel path it's invoked from
 *     the local webhook server's HTTP handler with body bytes wrapped in the
 *     same shape.
 *   - The current setting value (raw string from VS Code config).
 */
import { warnLog, errorLog, verboseLog } from "../utils/log";
import type { SmeePayload } from "./webhookSseParser.js";
import type { SmeeRelay } from "./webhookTunnel.js";
import {
  openTunnel,
  resolveTunnelType,
  type TunnelChannel,
  type TunnelOpenResult,
  type TunnelProviderType,
} from "./tunnelProviderRegistry.js";
import {
  startLocalWebhookServer,
  type LocalWebhookServer,
  type WebhookHandler,
} from "./webhookLocalServer.js";

// Re-export the types so callers don't have to know two different modules.
export type { SmeePayload } from "./webhookSseParser.js";

/** Lazy-load the smee module so the vscode-dependent import does not pull
 * vscode into vitest unit-tests that always pass `smeeRelayOverride`. */
async function loadSmeeRelay(handler: (payload: SmeePayload) => void): Promise<SmeeRelay> {
  const mod = await import("./webhookTunnel.js");
  return mod.createAndStartSmeeRelay(handler);
}

export interface TunnelRelayHandle {
  /** Public URL of the relay (smee.io channel or cloudflared/tailscale URL). */
  readonly publicUrl: string;
  /** Backend that won the dispatch. May differ from caller's preference if a
   * fallback to smee occurred. */
  readonly provider: TunnelProviderType;
  /** Tear down the relay (idempotent). */
  dispose(): Promise<void>;
}

export interface CreateAndStartTunnelRelayOptions {
  /** Raw setting value from `vscodesync.webhooks.tunnelProvider`. */
  rawProviderSetting: string | undefined;
  /** Common SmeePayload-shaped sink (re-used for both relay paths). */
  handler: (payload: SmeePayload) => void;
  /** When true and tunnel backend fails, do NOT fall back to smee — return
   * undefined instead. Default false (fallback). */
  noFallback?: boolean;
  /** For tests: override openTunnel. */
  openTunnelOverride?: typeof openTunnel;
  /** For tests: override smee path. */
  smeeRelayOverride?: () => Promise<SmeeRelay>;
  /** For tests: override local server path. */
  localServerFactory?: typeof startLocalWebhookServer;
}

export async function createAndStartTunnelRelay(
  options: CreateAndStartTunnelRelayOptions,
): Promise<TunnelRelayHandle | undefined> {
  const requested = resolveTunnelType(options.rawProviderSetting);

  if (requested === "smee") {
    return startSmeePath(options);
  }

  const channel = await tryOpenTunnel(requested, options);
  if (channel) return channel;

  if (options.noFallback) return undefined;
  warnLog("tunnel", `falling back to smee.io because backend "${requested}" was unavailable`);
  return startSmeePath(options);
}

async function startSmeePath(
  options: CreateAndStartTunnelRelayOptions,
): Promise<TunnelRelayHandle> {
  const factory = options.smeeRelayOverride ?? (() => loadSmeeRelay(options.handler));
  const relay = await factory();
  return {
    publicUrl: relay.channelUrl,
    provider: "smee",
    dispose: () => {
      relay.dispose();
      return Promise.resolve();
    },
  };
}

async function tryOpenTunnel(
  type: Exclude<TunnelProviderType, "smee">,
  options: CreateAndStartTunnelRelayOptions,
): Promise<TunnelRelayHandle | undefined> {
  const opener = options.openTunnelOverride ?? openTunnel;
  const localFactory = options.localServerFactory ?? startLocalWebhookServer;

  const handler: WebhookHandler = (req) => {
    if (req.method !== "POST") {
      return { status: 405 };
    }
    try {
      const raw = req.body.toString("utf8");
      // Shape the incoming HTTP webhook to the SmeePayload contract so the
      // existing handler does not need to know which backend delivered the
      // notification.
      let parsedBody: Record<string, unknown> = {};
      if (raw.length > 0) {
        try {
          const j: unknown = JSON.parse(raw);
          if (j !== null && typeof j === "object") {
            parsedBody = j as Record<string, unknown>;
          }
        } catch {
          // Non-JSON webhooks are ignored — providers we care about all
          // post JSON. Log at warn so unexpected shapes surface.
          warnLog("tunnel", "non-JSON webhook body, ignoring");
          return { status: 400 };
        }
      }
      const payload: SmeePayload = {
        body: parsedBody,
        headers: { ...req.headers },
      };
      options.handler(payload);
      return { status: 202 };
    } catch (err) {
      errorLog("tunnel", "handler threw", err);
      return { status: 500 };
    }
  };

  let server: LocalWebhookServer;
  try {
    server = await localFactory({ handler });
  } catch (err) {
    errorLog("tunnel", "local webhook server failed to bind", err);
    return undefined;
  }

  let result: TunnelOpenResult;
  try {
    result = await opener(type, server.port);
  } catch (err) {
    errorLog("tunnel", `openTunnel(${type}) threw`, err);
    await server.dispose();
    return undefined;
  }

  if (!result.ok) {
    warnLog("tunnel", `${type} unavailable: ${result.reason} ${result.detail ?? ""}`.trim());
    await server.dispose();
    return undefined;
  }

  const channel: TunnelChannel = result.channel;
  verboseLog("tunnel", `${type} channel up: ${channel.publicUrl}`);
  let disposed = false;
  return {
    publicUrl: channel.publicUrl,
    provider: type,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await channel.dispose();
      } catch (err) {
        errorLog("tunnel", "tunnel channel dispose failed", err);
      }
      try {
        await server.dispose();
      } catch (err) {
        errorLog("tunnel", "local webhook server dispose failed", err);
      }
    },
  };
}
