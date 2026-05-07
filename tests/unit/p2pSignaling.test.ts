/**
 * Tests for `encodeSignal` / `decodeSignal` — the wire envelope used by the
 * upcoming WebRTC P2P channel. Decoder is intentionally strict:
 *   - rejects schema-mismatch / bad shapes
 *   - rejects payloads addressed to the wrong machine
 *   - rejects stale (replay) envelopes by ts vs `now`
 */
import { describe, it, expect } from "vitest";
import {
  decodeSignal,
  encodeSignal,
  newSessionId,
  type P2PSignal,
} from "../../src/core/p2pSignaling.js";

const sample: P2PSignal = {
  kind: "offer",
  sdp: "v=0\no=- 1 1 IN IP4 127.0.0.1\ns=-\nt=0 0\n",
  fromMachineId: "M-A",
  toMachineId: "M-B",
  sessionId: "deadbeef",
};

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function envelope(): unknown {
  return encodeSignal(sample, new Date(NOW).toISOString());
}

describe("encodeSignal", () => {
  it("wraps the payload with version + timestamp", () => {
    const env = encodeSignal(sample, "2026-06-01T00:00:00Z");
    expect(env.v).toBe(1);
    expect(env.ts).toBe("2026-06-01T00:00:00Z");
    expect(env.signal).toEqual(sample);
  });
});

describe("decodeSignal", () => {
  it("accepts a fresh envelope addressed to me", () => {
    const r = decodeSignal(envelope(), "M-B", NOW + 1000);
    expect(r.ok).toBe(true);
  });

  it("rejects null / non-object", () => {
    expect(decodeSignal(null, "M-B", NOW).ok).toBe(false);
    expect(decodeSignal("string", "M-B", NOW).ok).toBe(false);
  });

  it("rejects wrong schema version", () => {
    const e = encodeSignal(sample, new Date(NOW).toISOString()) as unknown as { v: number };
    e.v = 2;
    expect(decodeSignal(e, "M-B", NOW + 100)).toEqual({ ok: false, reason: "bad_shape" });
  });

  it("rejects stale envelopes (older than freshness window)", () => {
    const r = decodeSignal(envelope(), "M-B", NOW + 60_000);
    expect(r).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects envelopes addressed to another machine", () => {
    const r = decodeSignal(envelope(), "M-OTHER", NOW + 100);
    expect(r).toEqual({ ok: false, reason: "wrong_recipient" });
  });

  it("rejects offer without sdp", () => {
    const env = encodeSignal({ ...sample, sdp: undefined as unknown as string });
    expect(decodeSignal(env, "M-B", NOW + 100).ok).toBe(false);
  });

  it("accepts ice candidate with null sdpMid + numeric sdpMLineIndex", () => {
    const env = encodeSignal(
      {
        kind: "ice",
        candidate: "candidate:1 1 UDP 100 1.2.3.4 50000 typ host",
        sdpMid: null,
        sdpMLineIndex: 0,
        fromMachineId: "M-A",
        toMachineId: "M-B",
        sessionId: "deadbeef",
      },
      new Date(NOW).toISOString(),
    );
    const r = decodeSignal(env, "M-B", NOW + 100);
    expect(r.ok).toBe(true);
  });

  it("rejects ice with non-finite sdpMLineIndex", () => {
    const env = encodeSignal(
      {
        kind: "ice",
        candidate: "candidate:1",
        sdpMid: "0",
        sdpMLineIndex: Number.NaN,
        fromMachineId: "M-A",
        toMachineId: "M-B",
        sessionId: "deadbeef",
      },
      new Date(NOW).toISOString(),
    );
    expect(decodeSignal(env, "M-B", NOW + 100).ok).toBe(false);
  });

  it("accepts a bye envelope without reason", () => {
    const env = encodeSignal(
      {
        kind: "bye",
        fromMachineId: "M-A",
        toMachineId: "M-B",
        sessionId: "deadbeef",
      },
      new Date(NOW).toISOString(),
    );
    expect(decodeSignal(env, "M-B", NOW + 100).ok).toBe(true);
  });

  it("rejects unknown kind", () => {
    const env = encodeSignal(
      { kind: "unknown" as never, fromMachineId: "A", toMachineId: "B", sessionId: "x" },
      new Date(NOW).toISOString(),
    );
    expect(decodeSignal(env, "B", NOW + 100).ok).toBe(false);
  });
});

describe("newSessionId", () => {
  it("returns a 16-char hex string", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns different ids on successive calls", () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });
});
