/**
 * v2.1.5 — pure helpers that build / decode heartbeat ping & pong payloads.
 *
 * Wire format inside the AES-encrypted envelope is a fixed-shape JSON object:
 *
 *   ping: { v: 1, sentAtMs: number }
 *   pong: { v: 1, sentAtMs: number, peerAtMs: number }
 *
 * `sentAtMs` round-trips so the sender can compute RTT without consulting
 * its own state. `peerAtMs` is set by the responder so the original sender
 * can monitor relative clock drift.
 *
 * No `vscode` import. No timer here — caller decides when to send.
 */

export const HEARTBEAT_FRAME_VERSION = 1;

export interface HeartbeatPingPayload {
  v: typeof HEARTBEAT_FRAME_VERSION;
  sentAtMs: number;
}

export interface HeartbeatPongPayload {
  v: typeof HEARTBEAT_FRAME_VERSION;
  sentAtMs: number;
  peerAtMs: number;
}

export type DecodeHeartbeatResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: "bad_json" | "missing_field" | "bad_field" | "bad_version" };

/** Build a `ping` payload buffer for `sendFrame("ping", ...)`. */
export function buildHeartbeatPing(nowMs: number): Buffer {
  if (!Number.isFinite(nowMs)) {
    throw new Error("buildHeartbeatPing: nowMs must be finite");
  }
  const obj: HeartbeatPingPayload = { v: HEARTBEAT_FRAME_VERSION, sentAtMs: nowMs };
  return Buffer.from(JSON.stringify(obj), "utf8");
}

/** Build a `pong` payload buffer in response to a decoded ping. */
export function buildHeartbeatPong(receivedPing: HeartbeatPingPayload, nowMs: number): Buffer {
  if (!Number.isFinite(nowMs)) {
    throw new Error("buildHeartbeatPong: nowMs must be finite");
  }
  const obj: HeartbeatPongPayload = {
    v: HEARTBEAT_FRAME_VERSION,
    sentAtMs: receivedPing.sentAtMs,
    peerAtMs: nowMs,
  };
  return Buffer.from(JSON.stringify(obj), "utf8");
}

/** Strict ping decoder. Caller has already unwrapped the AES envelope and
 * passes the inner payload buffer here. */
export function decodeHeartbeatPing(payload: Buffer): DecodeHeartbeatResult<HeartbeatPingPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "bad_json" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.v !== "number") return { ok: false, reason: "missing_field" };
  if (obj.v !== HEARTBEAT_FRAME_VERSION) return { ok: false, reason: "bad_version" };
  if (typeof obj.sentAtMs !== "number" || !Number.isFinite(obj.sentAtMs)) {
    return { ok: false, reason: "bad_field" };
  }
  return { ok: true, payload: { v: HEARTBEAT_FRAME_VERSION, sentAtMs: obj.sentAtMs } };
}

/** Strict pong decoder. Same trust boundary as `decodeHeartbeatPing`. */
export function decodeHeartbeatPong(payload: Buffer): DecodeHeartbeatResult<HeartbeatPongPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "bad_json" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.v !== "number") return { ok: false, reason: "missing_field" };
  if (obj.v !== HEARTBEAT_FRAME_VERSION) return { ok: false, reason: "bad_version" };
  if (typeof obj.sentAtMs !== "number" || !Number.isFinite(obj.sentAtMs)) {
    return { ok: false, reason: "bad_field" };
  }
  if (typeof obj.peerAtMs !== "number" || !Number.isFinite(obj.peerAtMs)) {
    return { ok: false, reason: "bad_field" };
  }
  return {
    ok: true,
    payload: {
      v: HEARTBEAT_FRAME_VERSION,
      sentAtMs: obj.sentAtMs,
      peerAtMs: obj.peerAtMs,
    },
  };
}

/** Compute RTT given a returned pong + the local "now" at receive. */
export function computeHeartbeatRtt(pong: HeartbeatPongPayload, nowMs: number): number {
  const rtt = nowMs - pong.sentAtMs;
  return rtt < 0 ? 0 : rtt;
}
