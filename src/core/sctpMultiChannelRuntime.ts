/**
 * v2.20.2 — multi-DataChannel runtime backed by `RTCPeerConnection` (skeleton).
 *
 * Pairs with `src/core/p2pSctpMultiplex.ts:planSctpLane`. The skeleton in
 * `sctpRuntimeHook.ts` typed the surface; this module adds a *reference
 * implementation* that opens N stable channels on a given peer connection
 * and routes through the lane planner. The implementation is parameterised
 * over an injected RTC factory so tests can stub it without `@roamhq/wrtc`.
 *
 * Why a separate file: `sctpRuntimeHook.ts` exposed only the typed surface
 * + skeleton sentinel. The full runtime carries real wiring (channels[],
 * onmessage handlers) and depends on the proposed `RTCPeerConnection`
 * surface. Both modules share `SctpRuntimeAdapter`.
 *
 * No `vscode` import. Caller injects two factories:
 *   - `peerFactory` — returns a configured `RTCPeerConnection`-shaped object.
 *   - `now` — clock seam for tests.
 */
import {
  planSctpLane,
  type SctpLanePayloadKind,
} from "./p2pSctpMultiplex.js";
import type {
  SctpRuntimeAdapter,
  SctpRuntimeFrame,
} from "./sctpRuntimeHook.js";

export interface RTCDataChannelLike {
  readonly id: number | null;
  send(data: ArrayBuffer | Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array }) => void) | null;
  readyState: "connecting" | "open" | "closing" | "closed";
}

export interface RTCPeerConnectionLike {
  createDataChannel(label: string, init?: { id?: number; negotiated?: boolean }): RTCDataChannelLike;
  close(): void;
}

export interface CreateMultiChannelRuntimeOptions {
  readonly lanes: number;
  readonly peer: RTCPeerConnectionLike;
  /** Per-lane label prefix (`<labelPrefix>-<laneIdx>` becomes the channel
   *  label). Default `"vscodesync-lane"`. */
  readonly labelPrefix?: string;
  /** Inject a custom now() for tests. */
  readonly now?: () => number;
}

const DEFAULT_LABEL_PREFIX = "vscodesync-lane";

export function createMultiChannelSctpRuntime(
  options: CreateMultiChannelRuntimeOptions,
): SctpRuntimeAdapter {
  if (options.lanes < 1) {
    throw new Error(`createMultiChannelSctpRuntime: lanes must be >= 1, got ${String(options.lanes)}`);
  }
  const labelPrefix = options.labelPrefix ?? DEFAULT_LABEL_PREFIX;
  const channels: RTCDataChannelLike[] = [];
  const subscribers = new Set<(frame: SctpRuntimeFrame & { lane: number }) => void>();

  for (let i = 0; i < options.lanes; i += 1) {
    const ch = options.peer.createDataChannel(`${labelPrefix}-${String(i)}`, { id: i, negotiated: true });
    const laneIdx = i;
    ch.onmessage = (ev): void => {
      const payload = toUint8Array(ev.data);
      const decoded = decodeRuntimeFrame(payload);
      if (decoded === null) return;
      const fanout = { ...decoded, lane: laneIdx };
      for (const cb of subscribers) cb(fanout);
    };
    channels.push(ch);
  }

  return {
    lanes: options.lanes,
    async send(frame: SctpRuntimeFrame): Promise<void> {
      const assignment = planSctpLane({
        kind: frame.kind,
        stableKey: frame.stableKey,
        lanes: options.lanes,
      });
      const channel = channels.at(assignment.lane);
      if (channel === undefined) {
        throw new Error(`SCTP runtime: lane ${String(assignment.lane)} missing`);
      }
      const state = channel.readyState as string;
      if (state !== "open") {
        throw new Error(`SCTP runtime: lane ${String(assignment.lane)} not open (${state})`);
      }
      const wire = encodeRuntimeFrame(frame);
      channel.send(wire);
      return Promise.resolve();
    },
    onFrame(cb): () => void {
      subscribers.add(cb);
      return (): void => {
        subscribers.delete(cb);
      };
    },
    async close(): Promise<void> {
      for (const ch of channels) ch.close();
      options.peer.close();
      subscribers.clear();
      return Promise.resolve();
    },
  };
}

// ─── wire format ──────────────────────────────────────────────────────────

const RUNTIME_FRAME_VERSION = 1;

function kindToCode(kind: SctpLanePayloadKind): number {
  switch (kind) {
    case "manifest": return 1;
    case "control": return 2;
    case "file_chunk": return 3;
    case "heartbeat": return 4;
  }
}

function codeToKind(code: number): SctpLanePayloadKind | null {
  switch (code) {
    case 1: return "manifest";
    case 2: return "control";
    case 3: return "file_chunk";
    case 4: return "heartbeat";
    default: return null;
  }
}

/**
 * Wire layout: `[v=1:u8][kind:u8][payload...]`. Tests on the encoder/decoder
 * pin this; `wrapAuthenticated` from the existing crypto layer wraps the
 * frame separately.
 */
export function encodeRuntimeFrame(frame: SctpRuntimeFrame): Uint8Array {
  const out = new Uint8Array(2 + frame.payload.byteLength);
  out[0] = RUNTIME_FRAME_VERSION;
  out[1] = kindToCode(frame.kind);
  out.set(frame.payload, 2);
  return out;
}

export function decodeRuntimeFrame(buffer: Uint8Array): SctpRuntimeFrame | null {
  if (buffer.byteLength < 2) return null;
  if (buffer[0] !== RUNTIME_FRAME_VERSION) return null;
  const kind = codeToKind(buffer[1]);
  if (kind === null) return null;
  return { kind, payload: buffer.slice(2) };
}

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}
