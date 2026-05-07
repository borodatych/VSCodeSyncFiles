/**
 * Webhook tunnel via smee.io relay.
 * smee.io is a free webhook relay: external services POST to a public smee.io URL,
 * and we receive those payloads via SSE (Server-Sent Events) locally.
 *
 * Workflow:
 *  1. Call `createSmeeChannel()` → get a public URL (https://smee.io/{id}).
 *  2. Register this URL as the webhook `notificationUrl` with OneDrive/GDrive.
 *  3. Call `startSmeeRelay(channelUrl, localHandler)` — opens SSE stream.
 *  4. When the external service POSTs to smee.io, the handler is called locally.
 *  5. Call `dispose()` to close the SSE connection.
 */

import * as vscode from "vscode";

const SMEE_BASE = "https://smee.io";
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export type SmeePayload = {
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

export interface SmeeRelay {
  /** The public smee.io URL to register as your webhook endpoint. */
  readonly channelUrl: string;
  /** Close the SSE stream (idempotent). */
  dispose(): void;
}

/** Create a new smee.io channel. Returns the public URL. */
export async function createSmeeChannel(): Promise<string> {
  // GET https://smee.io/new → 301/302 redirect to https://smee.io/{channelId}
  const res = await fetch(`${SMEE_BASE}/new`, { redirect: "follow" });
  return res.url;
}

/**
 * Start listening to smee.io SSE relay and invoke `handler` for each received payload.
 * Automatically reconnects on network drops (up to MAX_RECONNECT_ATTEMPTS).
 *
 * @param channelUrl - The public smee.io URL (e.g. https://smee.io/abc123).
 * @param handler - Called with the parsed payload for each incoming webhook event.
 */
export function startSmeeRelay(
  channelUrl: string,
  handler: (payload: SmeePayload) => void,
): SmeeRelay {
  let disposed = false;
  let attempts = 0;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const connect = async (): Promise<void> => {
    if (disposed) return;
    try {
      const res = await fetch(channelUrl, {
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        throw new Error(`smee.io SSE connect failed: ${String(res.status)}`);
      }
      attempts = 0; // reset on successful connect
      currentReader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        if (disposed) break;
        const { done, value } = await currentReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Process complete SSE messages (delimited by \n\n)
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          parseAndDispatch(part, handler);
        }
      }
    } catch (e) {
      if (disposed) return;
      attempts += 1;
      if (attempts >= MAX_RECONNECT_ATTEMPTS) {
        void vscode.window.showWarningMessage(
          `VSCodeSync: smee.io tunnel потерял соединение после ${String(MAX_RECONNECT_ATTEMPTS)} попыток. Polling продолжится.`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      void connect();
    }
  };

  void connect();

  return {
    channelUrl,
    dispose() {
      disposed = true;
      currentReader?.cancel().catch(() => undefined);
      currentReader = null;
    },
  };
}

/**
 * Parse a single SSE message block and call the handler if it contains a `data:` line.
 * smee.io sends the full HTTP request (headers + body) as JSON in the `data` field.
 */
function parseAndDispatch(sseBlock: string, handler: (payload: SmeePayload) => void): void {
  let data = "";
  for (const line of sseBlock.split("\n")) {
    if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }
  if (!data || data === "connected") {
    return; // heartbeat or connection ack
  }
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    // smee.io wraps the original POST body under `body` key and headers under header fields
    const body = (parsed["body"] as Record<string, unknown> | undefined) ?? parsed;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k !== "body" && typeof v === "string") {
        headers[k] = v;
      }
    }
    handler({ body, headers });
  } catch {
    /* malformed JSON from smee.io — skip */
  }
}

/**
 * High-level helper: create a smee channel and start relaying.
 * Returns a SmeeRelay with the channelUrl for registration.
 */
export async function createAndStartSmeeRelay(
  handler: (payload: SmeePayload) => void,
): Promise<SmeeRelay> {
  const channelUrl = await createSmeeChannel();
  const relay = startSmeeRelay(channelUrl, handler);
  return relay;
}
