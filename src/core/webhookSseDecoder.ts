/**
 * v2.20.4 — Server-Sent Events decoder skeleton for the
 * Webhook → SSE upgrade path.
 *
 * Today VSCodeSync polls smee.io / a local relay for OneDrive / GDrive
 * webhook deliveries. Several providers (notably Google Drive Activity API,
 * partner endpoints exposing changes feeds) speak SSE natively — staying on
 * a single long-lived HTTP/2 connection avoids both long-poll latency and
 * the per-request quota cost.
 *
 * This module is a *pure decoder*: it takes a chunk of the SSE wire format
 * (`text/event-stream` per HTML5 SSE, RFC-equivalent) and returns
 * structured events. Network plumbing (open the connection, retry on 5xx,
 * heartbeat watchdog) lives in the wiring layer once we adopt SSE for a
 * specific provider.
 *
 * Wire format reminder:
 *
 *   event: change
 *   id: 42
 *   data: {"json":"goes here"}
 *   <blank line ends an event>
 *
 *   :keepalive
 *
 *   data: line one
 *   data: line two   ← multi-line data is joined with "\n"
 */

export interface SseEvent {
  /** `event:` field; defaults to `"message"` per spec. */
  readonly event: string;
  /** `id:` field if present. */
  readonly id?: string;
  /** Raw `data:` payload — multi-line entries already joined with `\n`. */
  readonly data: string;
  /** `retry:` field (ms) if present. */
  readonly retryMs?: number;
}

export interface SseDecoderState {
  buffer: string;
  /** Last seen `id:` (used for reconnection's `Last-Event-Id` header). */
  lastEventId?: string;
}

export function createSseDecoder(): {
  push: (chunk: string) => SseEvent[];
  state: () => Readonly<SseDecoderState>;
} {
  const state: SseDecoderState = { buffer: "" };

  return {
    push(chunk: string): SseEvent[] {
      state.buffer += chunk;
      const out: SseEvent[] = [];
      // Process complete events (ended by blank line).
      // Per spec, line endings are \r\n, \n, or \r — normalise.
      // Find next "\n\n", "\r\n\r\n", or "\r\r" boundary.
      for (;;) {
        const idx = findEventBoundary(state.buffer);
        if (idx === -1) break;
        const raw = state.buffer.slice(0, idx);
        state.buffer = state.buffer.slice(idx + boundaryLen(state.buffer, idx));
        const ev = parseEventBlock(raw);
        if (ev !== null) {
          if (ev.id !== undefined) state.lastEventId = ev.id;
          out.push(ev);
        }
      }
      return out;
    },
    state(): Readonly<SseDecoderState> {
      return state;
    },
  };
}

function findEventBoundary(s: string): number {
  // Search for a blank line: \n\n | \r\n\r\n | \r\r
  // Return the index where the first separator starts (so caller knows the
  // event body length); a separate helper computes the full sep length.
  const candidates = [s.indexOf("\r\n\r\n"), s.indexOf("\n\n"), s.indexOf("\r\r")];
  let best = -1;
  for (const c of candidates) {
    if (c === -1) continue;
    if (best === -1 || c < best) best = c;
  }
  return best;
}

function boundaryLen(s: string, idx: number): number {
  if (s.startsWith("\r\n\r\n", idx)) return 4;
  if (s.startsWith("\n\n", idx) || s.startsWith("\r\r", idx)) return 2;
  return 2;
}

function parseEventBlock(block: string): SseEvent | null {
  // Comments start with ":". Empty block = ignore (e.g. keepalive).
  if (block.length === 0) return null;
  const lines = block.split(/\r\n|\n|\r/);
  let event = "message";
  let id: string | undefined;
  let retryMs: number | undefined;
  const dataLines: string[] = [];
  let sawData = false;

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // comment / keepalive
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        sawData = true;
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n >= 0) retryMs = n;
        break;
      }
      default:
        // Unknown field → ignore per spec.
        break;
    }
  }

  if (!sawData) return null;
  return { event, id, data: dataLines.join("\n"), retryMs };
}

export class SseTransportNotImplementedError extends Error {
  readonly code = "sse_transport_not_implemented" as const;
  constructor(message?: string) {
    super(
      message ??
        "SSE transport is not wired yet (v2.20.4 in roadmap). The decoder is " +
          "ready; the per-provider connection (Google Drive Activity API streaming, " +
          "Graph subscription change-feed) lands in a follow-up.",
    );
    this.name = "SseTransportNotImplementedError";
  }
}
