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
import { warnLog, errorLog } from "../utils/log";
import { parseSmeeSseBlock, type SmeePayload } from "./webhookSseParser.js";

export type { SmeePayload } from "./webhookSseParser.js";

const SMEE_BASE = "https://smee.io";
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export interface SmeeRelay {
  /** The public smee.io URL to register as your webhook endpoint. */
  readonly channelUrl: string;
  /** Close the SSE stream (idempotent). */
  dispose(): void;
}

interface RelayState {
  disposed: boolean;
  attempts: number;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  abort: AbortController;
}

// Reading `state.disposed` through this helper hides the property from
// TypeScript's flow narrowing — the flag is mutated from outside the
// async function, but eslint's `no-unnecessary-condition` would otherwise
// treat the field as never-true inside the closure.
function isDisposed(s: RelayState): boolean {
  return (s as { disposed: boolean }).disposed;
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
  // Mutable state lives on an object so external `dispose()` writes are visible
  // to the in-flight `connect()` loop without tripping flow-based linters.
  const state: RelayState = {
    disposed: false,
    attempts: 0,
    reader: null,
    abort: new AbortController(),
  };

  const connect = async (): Promise<void> => {
    if (isDisposed(state)) return;
    state.abort = new AbortController();
    try {
      const res = await fetch(channelUrl, {
        headers: { Accept: "text/event-stream" },
        signal: state.abort.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`smee.io SSE connect failed: ${String(res.status)}`);
      }
      state.attempts = 0; // reset on successful connect
      state.reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        if (isDisposed(state)) break;
        const { done, value } = await state.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Process complete SSE messages (delimited by \n\n)
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          parseSmeeSseBlock(part, handler);
        }
      }
    } catch (err: unknown) {
      if (isDisposed(state)) return;
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || err.name === "ResetError");
      if (isAbort) return;
      errorLog("smeeRelay", "SSE error", err);
      state.attempts += 1;
      if (state.attempts >= MAX_RECONNECT_ATTEMPTS) {
        warnLog(
          "smeeRelay",
          `tunnel lost connection after ${String(MAX_RECONNECT_ATTEMPTS)} attempts; falling back to polling`,
        );
        void vscode.window.showWarningMessage(
          `VSCodeSync: smee.io tunnel потерял соединение после ${String(MAX_RECONNECT_ATTEMPTS)} попыток. Polling продолжится.`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      if (isDisposed(state)) return;
      void connect();
    }
  };

  void connect();

  return {
    channelUrl,
    dispose() {
      state.disposed = true;
      state.abort.abort();
      state.reader?.cancel().catch(() => undefined);
      state.reader = null;
    },
  };
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
