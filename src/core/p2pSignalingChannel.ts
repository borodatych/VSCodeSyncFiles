/**
 * v2.1.1 — pure path/envelope helpers for the cloud-provider-backed signaling
 * channel. The transport layer (`p2pSignalingTransport.ts`) does the actual
 * uploadFile/downloadFile/listFolder calls; this module just generates the
 * cloud paths and validates the envelope shape stored at each path.
 *
 * Cloud layout:
 *
 *     _p2p/{sessionId}/{offer|answer|ice|bye}.json   — single-shot signals
 *     _p2p/{sessionId}/ice/{candidateId}.json        — multi-shot ICE candidates
 *
 * Each blob is a `SignalingChannelEnvelope` (small, ≤ 2 KB, JSON-encoded).
 *
 * TTL: receivers MUST drop envelopes older than 60 s. Cleanup of stale
 * `_p2p/{sessionId}/` is the responsibility of the transport layer (5 min
 * idle).
 */
import type { P2PSignal } from "./p2pSignaling.js";

export const SIGNALING_CHANNEL_TTL_MS = 60_000;
export const SIGNALING_CHANNEL_CLEANUP_AFTER_IDLE_MS = 5 * 60_000;
/** Max envelope JSON size in bytes — guards against malicious oversized blobs. */
export const SIGNALING_CHANNEL_MAX_BYTES = 16 * 1024;

export type SignalingKind = "offer" | "answer" | "ice" | "bye";

export interface SignalingChannelEnvelope {
  /** Bumped only on wire-shape changes. */
  v: 1;
  /** Producer-side timestamp (ms since epoch). Receiver checks freshness. */
  ts: number;
  /** sessionId duplicates the path component for tamper detection. */
  sessionId: string;
  /** kind duplicates the path component for tamper detection. */
  kind: SignalingKind;
  /** Per-ICE candidate id, undefined for offer/answer/bye. */
  candidateId?: string;
  /** The actual P2P signal payload (re-uses existing P2PSignal types). */
  signal: P2PSignal;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CANDIDATE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Throws on invalid sessionId so paths can never escape `_p2p/`. */
function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`p2pSignalingChannel: invalid sessionId "${sessionId}"`);
  }
}

function assertCandidateId(candidateId: string): void {
  if (!CANDIDATE_ID_RE.test(candidateId)) {
    throw new Error(`p2pSignalingChannel: invalid candidateId "${candidateId}"`);
  }
}

/** Cloud path for offer/answer/bye (single-shot per session). */
export function cloudPathForSignaling(
  sessionId: string,
  kind: "offer" | "answer" | "bye",
): string {
  assertSessionId(sessionId);
  return `_p2p/${sessionId}/${kind}.json`;
}

/** Cloud path for one ICE candidate. ICE is multi-shot — each candidate gets
 * its own blob to avoid lost-update races. */
export function cloudPathForIceCandidate(sessionId: string, candidateId: string): string {
  assertSessionId(sessionId);
  assertCandidateId(candidateId);
  return `_p2p/${sessionId}/ice/${candidateId}.json`;
}

/** Folder path for cleanup / listing all session blobs. */
export function cloudPathForSessionFolder(sessionId: string): string {
  assertSessionId(sessionId);
  return `_p2p/${sessionId}`;
}

export type ChannelEnvelopeDecodeResult =
  | { ok: true; envelope: SignalingChannelEnvelope }
  | {
      ok: false;
      reason:
        | "bad_json"
        | "bad_shape"
        | "kind_mismatch"
        | "session_mismatch"
        | "stale"
        | "oversized";
    };

export interface DecodeOptions {
  /** sessionId from the path; envelope must match. */
  expectedSessionId: string;
  /** kind from the path; envelope must match. */
  expectedKind: SignalingKind;
  /** Current ms. Default — `Date.now()`. */
  now?: number;
  /** Override TTL (default `SIGNALING_CHANNEL_TTL_MS`). */
  ttlMs?: number;
}

/** Strict decoder: every field validated, freshness enforced, kind+sessionId
 * cross-checked against the path the caller used to download the blob. */
export function decodeSignalingEnvelope(raw: unknown, options: DecodeOptions): ChannelEnvelopeDecodeResult {
  const ttlMs = options.ttlMs ?? SIGNALING_CHANNEL_TTL_MS;
  const now = options.now ?? Date.now();

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > SIGNALING_CHANNEL_MAX_BYTES) return { ok: false, reason: "oversized" };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "bad_json" };
    }
  } else if (raw instanceof Uint8Array || (typeof Buffer !== "undefined" && raw instanceof Buffer)) {
    if (raw.byteLength > SIGNALING_CHANNEL_MAX_BYTES) return { ok: false, reason: "oversized" };
    try {
      parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return { ok: false, reason: "bad_json" };
    }
  }

  if (parsed === null || typeof parsed !== "object") return { ok: false, reason: "bad_shape" };
  const e = parsed as Record<string, unknown>;
  if (e.v !== 1) return { ok: false, reason: "bad_shape" };
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return { ok: false, reason: "bad_shape" };
  if (typeof e.sessionId !== "string") return { ok: false, reason: "bad_shape" };
  if (typeof e.kind !== "string") return { ok: false, reason: "bad_shape" };
  if (typeof e.signal !== "object" || e.signal === null) return { ok: false, reason: "bad_shape" };
  if (e.candidateId !== undefined && typeof e.candidateId !== "string") {
    return { ok: false, reason: "bad_shape" };
  }
  if (e.sessionId !== options.expectedSessionId) return { ok: false, reason: "session_mismatch" };
  if (e.kind !== options.expectedKind) return { ok: false, reason: "kind_mismatch" };
  if (now - e.ts > ttlMs) return { ok: false, reason: "stale" };

  return { ok: true, envelope: parsed as SignalingChannelEnvelope };
}

/** Build envelope for an offer/answer/bye signal. */
export function buildSignalingEnvelope(
  sessionId: string,
  kind: "offer" | "answer" | "bye",
  signal: P2PSignal,
  ts: number = Date.now(),
): SignalingChannelEnvelope {
  assertSessionId(sessionId);
  return { v: 1, ts, sessionId, kind, signal };
}

/** Build envelope for a single ICE candidate. */
export function buildIceCandidateEnvelope(
  sessionId: string,
  candidateId: string,
  signal: P2PSignal,
  ts: number = Date.now(),
): SignalingChannelEnvelope {
  assertSessionId(sessionId);
  assertCandidateId(candidateId);
  return { v: 1, ts, sessionId, kind: "ice", candidateId, signal };
}
