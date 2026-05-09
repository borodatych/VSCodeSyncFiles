/**
 * v2.20.2 — SCTP multiplexing planner for the WebRTC P2P transfer surface.
 *
 * Today `p2pFileTransfer.ts` ships every file over a single DataChannel. Once
 * v2.12 lands and real DataChannels are open, we want to spread parallel
 * transfers across N SCTP streams so the manifest exchange isn't blocked by
 * a slow bulk-file transfer behind it.
 *
 * This module is a *pure planner* — it decides which logical "lane" a given
 * payload should ride on, given a fixed pool of N channels. The wiring
 * (RTCPeerConnection / DataChannel creation) happens later inside
 * `p2pSessionRuntime`.
 *
 * Lane policy:
 *   - Lane 0 — manifest / control (always priority).
 *   - Lane 1..N-1 — bulk file chunks, round-robin by content hash.
 *
 * If `lanes < 2`, behaviour falls back to single-lane (everything → lane 0)
 * — the wiring layer must guarantee `lanes ≥ 1` so the planner never
 * produces an out-of-range index.
 */

export type SctpLanePayloadKind =
  | "manifest"
  | "control"
  | "file_chunk"
  | "heartbeat";

export interface SctpLaneAssignment {
  /** Lane index in [0, lanes). */
  readonly lane: number;
  /** Kept verbatim so the receiver can route on the same field. */
  readonly kind: SctpLanePayloadKind;
  /**
   * Reason the planner picked this lane — useful for trace logs / tests so
   * intent is recorded next to the index.
   */
  readonly reason: "control_lane" | "round_robin" | "single_lane_fallback";
}

export interface SctpPlanInput {
  readonly kind: SctpLanePayloadKind;
  /**
   * Stable identifier used for round-robin distribution of bulk payloads.
   * For file chunks: usually the SHA-256 (or BLAKE3) of the *file* — so
   * every chunk of one file lands on the same lane and chunks stay ordered.
   */
  readonly stableKey?: string;
  /** Number of SCTP streams the session has negotiated. Min 1. */
  readonly lanes: number;
}

const CONTROL_LANE = 0;

export function planSctpLane(input: SctpPlanInput): SctpLaneAssignment {
  if (input.lanes < 1) {
    throw new Error(`planSctpLane: lanes must be >= 1, got ${String(input.lanes)}`);
  }
  if (input.lanes === 1) {
    return { lane: 0, kind: input.kind, reason: "single_lane_fallback" };
  }
  if (input.kind === "manifest" || input.kind === "control" || input.kind === "heartbeat") {
    return { lane: CONTROL_LANE, kind: input.kind, reason: "control_lane" };
  }
  // File chunks → round-robin over [1, lanes-1] using stableKey.
  const bulkLanes = input.lanes - 1; // exclude control lane
  const idx = (hashString(input.stableKey ?? "") % bulkLanes) + 1;
  return { lane: idx, kind: input.kind, reason: "round_robin" };
}

/**
 * Tiny FNV-1a 32-bit hash — deterministic across machines / Node versions
 * without pulling crypto for what's basically a load-balancer modulo.
 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface SctpPlannerSnapshot {
  readonly lanes: number;
  /** How many payloads have been assigned per lane since the planner was created. */
  readonly assignmentsPerLane: readonly number[];
}

/**
 * Stateful façade — convenient when caller wants the planner to track lane
 * load (for diagnostics) without doing the bookkeeping itself.
 */
export function createSctpPlanner(lanes: number): {
  assign: (input: Omit<SctpPlanInput, "lanes">) => SctpLaneAssignment;
  snapshot: () => SctpPlannerSnapshot;
} {
  if (lanes < 1) throw new Error(`createSctpPlanner: lanes must be >= 1, got ${String(lanes)}`);
  const counts = new Array<number>(lanes).fill(0);
  return {
    assign(input): SctpLaneAssignment {
      const out = planSctpLane({ ...input, lanes });
      counts[out.lane] = (counts[out.lane] ?? 0) + 1;
      return out;
    },
    snapshot(): SctpPlannerSnapshot {
      return { lanes, assignmentsPerLane: counts.slice() };
    },
  };
}
