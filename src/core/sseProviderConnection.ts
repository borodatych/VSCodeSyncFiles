/**
 * v2.20.4 — per-provider SSE connection adapter (skeleton).
 *
 * Pairs with the pure decoder `webhookSseDecoder.ts` and the per-provider
 * config `sseProviderRegistry.ts` (4 providers, all `available: false`
 * today). This module is the *connection adapter*: when a provider does
 * announce a streaming endpoint, this is what opens the long-lived HTTP
 * connection and feeds bytes into the decoder.
 *
 * Today: typed surface + skeleton noop transport that throws the
 * documented sentinel `SseProviderUnavailableError`. The real connector
 * lands once a provider exposes an SSE endpoint (likely Drive Activity
 * API streaming first).
 */
import {
  getSseProviderConfig,
  SseProviderUnavailableError,
  type SseProviderId,
} from "./sseProviderRegistry.js";
import { createSseDecoder, type SseEvent } from "./webhookSseDecoder.js";

export interface SseConnection {
  readonly providerId: SseProviderId;
  /** Resolves once the connection settles (HTTP 2xx + first byte). Rejects
   *  on transport failure or `SseProviderUnavailableError`. */
  readonly ready: Promise<void>;
  /** Subscribe to decoded events. Returns unsubscriber. */
  readonly onEvent: (cb: (ev: SseEvent) => void) => () => void;
  /** Subscribe to transport-level errors (HTTP 5xx, network). */
  readonly onError: (cb: (err: Error) => void) => () => void;
  /** Tear down the connection + abort the in-flight fetch. */
  readonly close: () => void;
}

export interface OpenSseConnectionOptions {
  readonly providerId: SseProviderId;
  /** Auth token from the provider's existing token bundle. */
  readonly accessToken: string;
  /** AbortSignal for the long-lived fetch — caller owns lifecycle. */
  readonly abortSignal: AbortSignal;
  /** Inject a fetch impl for tests; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Opens an SSE connection for the given provider. Today every provider
 * config has `available: false` — so this always rejects with
 * `SseProviderUnavailableError`. The signature is forward-stable.
 */
export function openSseConnection(options: OpenSseConnectionOptions): SseConnection {
  const config = getSseProviderConfig(options.providerId);
  const reason = config?.unavailableReason ?? "no provider config";
  if (config?.available !== true) {
    return makeRejectedConnection(options.providerId, new SseProviderUnavailableError(options.providerId, reason));
  }
  // Forward path — implemented when a provider goes `available: true`.
  return makeLiveConnection(options, config.endpointUrl);
}

function makeRejectedConnection(providerId: SseProviderId, err: Error): SseConnection {
  return {
    providerId,
    ready: Promise.reject(err),
    onEvent: () => () => { /* no-op */ },
    onError: (cb) => {
      // Surface the error via the standard error sink so callers can route
      // to UI without awaiting `ready`.
      queueMicrotask(() => { cb(err); });
      return (): void => { /* no-op */ };
    },
    close: () => { /* no-op */ },
  };
}

function makeLiveConnection(
  options: OpenSseConnectionOptions,
  endpointUrl: string,
): SseConnection {
  const eventCbs = new Set<(ev: SseEvent) => void>();
  const errorCbs = new Set<(err: Error) => void>();
  const decoder = createSseDecoder();
  const fetchImpl = options.fetchImpl ?? fetch;

  const ready = (async (): Promise<void> => {
    const res = await fetchImpl(endpointUrl, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${options.accessToken}`,
      },
      signal: options.abortSignal,
    });
    if (!res.ok) {
      throw new Error(`SSE handshake failed: HTTP ${String(res.status)}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("SSE: response has no body reader");
    const decoderText = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoderText.decode(value, { stream: true });
          for (const ev of decoder.push(chunk)) {
            for (const cb of eventCbs) cb(ev);
          }
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        for (const cb of errorCbs) cb(e);
      }
    })();
  })();

  return {
    providerId: options.providerId,
    ready,
    onEvent: (cb) => {
      eventCbs.add(cb);
      return (): void => { eventCbs.delete(cb); };
    },
    onError: (cb) => {
      errorCbs.add(cb);
      return (): void => { errorCbs.delete(cb); };
    },
    close: () => {
      eventCbs.clear();
      errorCbs.clear();
    },
  };
}
