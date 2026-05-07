/**
 * @experimental v2.1 WebRTC P2P. Wired in v2.x. Keep until full DataChannel
 * + UI commands land; do NOT delete as "dead code".
 *
 * WebRTC P2P signaling envelope (skeleton — v2.1 in roadmap).
 *
 * v1 implementation goals (this file):
 *   - Wire-format types for SDP offer / answer / ICE candidates exchanged via
 *     the existing webhook channel (`_machines.json`-adjacent key, or smee.io
 *     relay).
 *   - Pure helpers `encodeSignal` / `decodeSignal` so the eventual transport
 *     can swap in without retyping (smee, webhook, or Cloudflare-tunnel).
 *
 * What's NOT here yet:
 *   - Actual `RTCPeerConnection` / `RTCDataChannel` setup — those need the
 *     Node WebRTC backend (`@roamhq/wrtc` or browser-native in web variant).
 *   - DTLS payload framing — will reuse `ICrypto` AES-GCM once the data
 *     channel is in place.
 *
 * The skeleton exists so signaling messages can be modeled and tested today,
 * and the data-channel layer drops in without API churn.
 */

export type P2PSignalKind = "offer" | "answer" | "ice" | "bye";

export interface P2POffer {
  kind: "offer";
  /** RTCSessionDescription.sdp */
  sdp: string;
  /** Sender machineId (must match _machines.json). */
  fromMachineId: string;
  /** Intended recipient machineId. */
  toMachineId: string;
  /** Offer round-trip id; pairs offer with answer. */
  sessionId: string;
}

export interface P2PAnswer {
  kind: "answer";
  sdp: string;
  fromMachineId: string;
  toMachineId: string;
  sessionId: string;
}

export interface P2PIce {
  kind: "ice";
  candidate: string;
  /** RTC sdpMid + sdpMLineIndex; both required by browsers. */
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  fromMachineId: string;
  toMachineId: string;
  sessionId: string;
}

export interface P2PBye {
  kind: "bye";
  fromMachineId: string;
  toMachineId: string;
  sessionId: string;
  reason?: string;
}

export type P2PSignal = P2POffer | P2PAnswer | P2PIce | P2PBye;

export interface SignalEnvelope {
  /** Schema version of the envelope (bump when wire shape changes). */
  v: 1;
  /** ISO timestamp; signaling drops envelopes older than 30 s to discourage replay. */
  ts: string;
  /** Encoded payload — see `P2PSignal`. */
  signal: P2PSignal;
}

export const SIGNAL_FRESHNESS_MS = 30_000;

/** Build a wire envelope from a signal payload. Caller fills `ts` for testability. */
export function encodeSignal(signal: P2PSignal, ts = new Date().toISOString()): SignalEnvelope {
  return { v: 1, ts, signal };
}

export type DecodeResult =
  | { ok: true; envelope: SignalEnvelope }
  | { ok: false; reason: "bad_json" | "bad_shape" | "stale" | "wrong_recipient" };

/** Strict decoder. `expectedRecipientMachineId` is mandatory: signaling never
 * delivers to "anyone listening". `now` and `freshnessMs` are explicit so the
 * helper is fully deterministic in tests. */
export function decodeSignal(
  raw: unknown,
  expectedRecipientMachineId: string,
  now: number = Date.now(),
  freshnessMs: number = SIGNAL_FRESHNESS_MS,
): DecodeResult {
  if (raw === null || typeof raw !== "object") return { ok: false, reason: "bad_shape" };
  const e = raw as { v?: unknown; ts?: unknown; signal?: unknown };
  if (e.v !== 1) return { ok: false, reason: "bad_shape" };
  if (typeof e.ts !== "string") return { ok: false, reason: "bad_shape" };
  if (typeof e.signal !== "object" || e.signal === null) return { ok: false, reason: "bad_shape" };
  const t = Date.parse(e.ts);
  if (Number.isNaN(t)) return { ok: false, reason: "bad_shape" };
  if (now - t > freshnessMs) return { ok: false, reason: "stale" };

  const s = e.signal as Record<string, unknown>;
  if (typeof s.kind !== "string") return { ok: false, reason: "bad_shape" };
  if (typeof s.fromMachineId !== "string") return { ok: false, reason: "bad_shape" };
  if (typeof s.toMachineId !== "string") return { ok: false, reason: "bad_shape" };
  if (typeof s.sessionId !== "string") return { ok: false, reason: "bad_shape" };
  if (s.toMachineId !== expectedRecipientMachineId) {
    return { ok: false, reason: "wrong_recipient" };
  }
  switch (s.kind) {
    case "offer":
    case "answer":
      if (typeof s.sdp !== "string") return { ok: false, reason: "bad_shape" };
      break;
    case "ice":
      if (typeof s.candidate !== "string") return { ok: false, reason: "bad_shape" };
      if (s.sdpMid !== null && typeof s.sdpMid !== "string") return { ok: false, reason: "bad_shape" };
      if (
        s.sdpMLineIndex !== null &&
        (typeof s.sdpMLineIndex !== "number" || !Number.isFinite(s.sdpMLineIndex))
      ) {
        return { ok: false, reason: "bad_shape" };
      }
      break;
    case "bye":
      if (s.reason !== undefined && typeof s.reason !== "string") {
        return { ok: false, reason: "bad_shape" };
      }
      break;
    default:
      return { ok: false, reason: "bad_shape" };
  }
  return { ok: true, envelope: e as SignalEnvelope };
}

/** Generate a random sessionId without pulling node:crypto (used in browser too). */
export function newSessionId(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto !== "undefined" && "getRandomValues" in globalThis.crypto) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
