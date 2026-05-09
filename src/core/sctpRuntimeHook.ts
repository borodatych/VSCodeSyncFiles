/**
 * v2.20.2 — SCTP multi-DataChannel runtime adapter (skeleton).
 *
 * Pairs with `src/core/p2pSctpMultiplex.ts:planSctpLane`. Today
 * `openP2PSession` opens **one** DataChannel and routes every payload
 * through it. SCTP supports multiple parallel streams natively
 * (see `RTCDataChannel.id` / `RTCSctpTransport.maxChannels`); the runtime
 * adapter described here will:
 *
 *   1. After offer/answer + ICE complete, open `lanes` DataChannels with
 *      stable ids (lane index = `dataChannel.id`).
 *   2. Wrap each in `wrapAuthenticated(channel, key)` to share the auth
 *      sequence space (separate `outSeq` / `expectedInSeq` per lane).
 *   3. Expose `send(kind, payload, stableKey?)` that consults
 *      `planSctpLane` and routes the payload to the right lane.
 *
 * This module is the *typed surface*: it defines the runtime adapter
 * shape + a sentinel error so the wiring layer fails closed instead of
 * silently dropping back to single-channel.
 */
import type { SctpLanePayloadKind } from "./p2pSctpMultiplex.js";

export interface SctpRuntimeFrame {
  readonly kind: SctpLanePayloadKind;
  readonly payload: Uint8Array;
  /** Stable identifier for round-robin among bulk lanes. */
  readonly stableKey?: string;
}

export interface SctpRuntimeAdapter {
  readonly lanes: number;
  /** Send via the planner's chosen lane. Resolves once the lane buffer is
   *  drained or rejects on send failure. */
  readonly send: (frame: SctpRuntimeFrame) => Promise<void>;
  /** Subscribe to inbound frames; the adapter merges all lanes into one
   *  callback (lane index is preserved on the frame metadata). */
  readonly onFrame: (cb: (frame: SctpRuntimeFrame & { lane: number }) => void) => () => void;
  /** Tear down all lanes. */
  readonly close: () => Promise<void>;
}

export class SctpRuntimeNotImplementedError extends Error {
  readonly code = "sctp_runtime_not_wired" as const;
  constructor(message?: string) {
    super(
      message ??
        "SCTP multi-DataChannel runtime is not wired yet (v2.20.2 in roadmap). " +
          "The lane planner is ready; the runtime adapter (multiple RTCDataChannel " +
          "instances + per-lane authenticated channels) lands when single-channel P2P " +
          "is observed in production.",
    );
    this.name = "SctpRuntimeNotImplementedError";
  }
}

/** Skeleton factory — caller can plug this into `openP2PSession` to get an
 *  explicit "not yet wired" error instead of accidentally opening only one
 *  lane and hiding the regression. */
export function makeSkeletonSctpRuntime(lanes: number): SctpRuntimeAdapter {
  const reject = (): Promise<never> => Promise.reject(new SctpRuntimeNotImplementedError());
  return {
    lanes,
    send: () => reject(),
    onFrame: () => () => { /* no-op */ },
    close: () => reject(),
  };
}
