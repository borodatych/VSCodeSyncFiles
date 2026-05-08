import { describe, expect, it } from "vitest";
import { encodeP2PFrame, decodeP2PFrame, P2P_FRAME_TYPE } from "../../src/core/p2pCryptoEnvelope.js";
import {
  buildHeartbeatPing,
  buildHeartbeatPong,
  computeHeartbeatRtt,
  decodeHeartbeatPing,
  decodeHeartbeatPong,
  HEARTBEAT_FRAME_VERSION,
} from "../../src/core/p2pHeartbeatFrames.js";

const KEY = Buffer.alloc(32, 0x10);

describe("P2P_FRAME_TYPE — ping/pong registration", () => {
  it("includes ping=5 and pong=6 in the type table", () => {
    expect(P2P_FRAME_TYPE.ping).toBe(5);
    expect(P2P_FRAME_TYPE.pong).toBe(6);
  });

  it("round-trips a ping frame through encode → decode preserving type", () => {
    const payload = buildHeartbeatPing(1_700_000_000_000);
    const frame = encodeP2PFrame(KEY, { type: "ping", seq: 0, payload });
    const decoded = decodeP2PFrame(KEY, frame, 0);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.type).toBe("ping");
  });

  it("round-trips a pong frame through encode → decode preserving type", () => {
    const ping = decodeHeartbeatPing(buildHeartbeatPing(1_700_000_000_000));
    if (!ping.ok) throw new Error("ping decode failed");
    const payload = buildHeartbeatPong(ping.payload, 1_700_000_000_500);
    const frame = encodeP2PFrame(KEY, { type: "pong", seq: 1, payload });
    const decoded = decodeP2PFrame(KEY, frame, 1);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.type).toBe("pong");
  });
});

describe("buildHeartbeatPing / decodeHeartbeatPing — round trip", () => {
  it("preserves sentAtMs", () => {
    const buf = buildHeartbeatPing(1_700_000_000_000);
    const r = decodeHeartbeatPing(buf);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.sentAtMs).toBe(1_700_000_000_000);
      expect(r.payload.v).toBe(HEARTBEAT_FRAME_VERSION);
    }
  });

  it("rejects non-finite sentAtMs at build time", () => {
    expect(() => buildHeartbeatPing(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rejects malformed JSON at decode", () => {
    expect(decodeHeartbeatPing(Buffer.from("not json")).ok).toBe(false);
  });

  it("rejects mismatched version", () => {
    const r = decodeHeartbeatPing(Buffer.from(JSON.stringify({ v: 99, sentAtMs: 1 })));
    expect(r).toEqual({ ok: false, reason: "bad_version" });
  });

  it("rejects payload missing sentAtMs", () => {
    const r = decodeHeartbeatPing(Buffer.from(JSON.stringify({ v: 1 })));
    expect(r).toEqual({ ok: false, reason: "bad_field" });
  });

  it("rejects null/array/string at top level", () => {
    expect(decodeHeartbeatPing(Buffer.from("null")).ok).toBe(false);
    expect(decodeHeartbeatPing(Buffer.from('[1,2]')).ok).toBe(false);
    expect(decodeHeartbeatPing(Buffer.from('"x"')).ok).toBe(false);
  });
});

describe("buildHeartbeatPong / decodeHeartbeatPong", () => {
  it("echoes the ping's sentAtMs and adds peerAtMs", () => {
    const ping = decodeHeartbeatPing(buildHeartbeatPing(1000));
    if (!ping.ok) throw new Error("ping decode failed");
    const buf = buildHeartbeatPong(ping.payload, 1500);
    const r = decodeHeartbeatPong(buf);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.sentAtMs).toBe(1000);
      expect(r.payload.peerAtMs).toBe(1500);
    }
  });

  it("rejects pong missing peerAtMs", () => {
    const r = decodeHeartbeatPong(Buffer.from(JSON.stringify({ v: 1, sentAtMs: 1 })));
    expect(r).toEqual({ ok: false, reason: "bad_field" });
  });

  it("rejects non-finite nowMs at build time", () => {
    expect(() => buildHeartbeatPong({ v: 1, sentAtMs: 0 }, Number.NaN)).toThrow();
  });
});

describe("computeHeartbeatRtt", () => {
  it("returns positive RTT for a normal round-trip", () => {
    expect(computeHeartbeatRtt({ v: 1, sentAtMs: 1000, peerAtMs: 1100 }, 1200)).toBe(200);
  });

  it("clamps negative RTT to 0 for clock-skew safety", () => {
    expect(computeHeartbeatRtt({ v: 1, sentAtMs: 1500, peerAtMs: 1600 }, 1000)).toBe(0);
  });
});
