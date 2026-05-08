import { describe, expect, it } from "vitest";
import {
  buildIceCandidateEnvelope,
  buildSignalingEnvelope,
  cloudPathForIceCandidate,
  cloudPathForSessionFolder,
  cloudPathForSignaling,
  decodeSignalingEnvelope,
  SIGNALING_CHANNEL_TTL_MS,
} from "../../src/core/p2pSignalingChannel.js";
import type { P2POffer, P2PAnswer, P2PIce, P2PBye } from "../../src/core/p2pSignaling.js";

const SID = "sess-1234abcd";
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

const offer: P2POffer = {
  kind: "offer",
  sdp: "v=0\n",
  fromMachineId: "A",
  toMachineId: "B",
  sessionId: SID,
};
const answer: P2PAnswer = { ...offer, kind: "answer" };
const ice: P2PIce = {
  kind: "ice",
  candidate: "candidate:1 1 UDP 2113937151 192.168.1.1 50000 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
  fromMachineId: "A",
  toMachineId: "B",
  sessionId: SID,
};
const bye: P2PBye = { kind: "bye", fromMachineId: "A", toMachineId: "B", sessionId: SID, reason: "done" };

describe("cloudPathForSignaling", () => {
  it("renders deterministic offer/answer/bye paths under _p2p/{sessionId}/", () => {
    expect(cloudPathForSignaling(SID, "offer")).toBe(`_p2p/${SID}/offer.json`);
    expect(cloudPathForSignaling(SID, "answer")).toBe(`_p2p/${SID}/answer.json`);
    expect(cloudPathForSignaling(SID, "bye")).toBe(`_p2p/${SID}/bye.json`);
  });

  it("rejects sessionIds that contain path-traversal characters", () => {
    expect(() => cloudPathForSignaling("../escape", "offer")).toThrow(/invalid sessionId/);
    expect(() => cloudPathForSignaling("a/b", "offer")).toThrow(/invalid sessionId/);
    expect(() => cloudPathForSignaling("", "offer")).toThrow(/invalid sessionId/);
  });
});

describe("cloudPathForIceCandidate", () => {
  it("places candidate blobs under _p2p/{sessionId}/ice/{candidateId}.json", () => {
    expect(cloudPathForIceCandidate(SID, "cand-01")).toBe(`_p2p/${SID}/ice/cand-01.json`);
  });

  it("rejects candidateIds that contain path-traversal characters", () => {
    expect(() => cloudPathForIceCandidate(SID, "../etc/passwd")).toThrow(/invalid candidateId/);
  });
});

describe("cloudPathForSessionFolder", () => {
  it("renders folder path used by the cleanup job", () => {
    expect(cloudPathForSessionFolder(SID)).toBe(`_p2p/${SID}`);
  });
});

describe("buildSignalingEnvelope + decodeSignalingEnvelope", () => {
  it("round-trips offer through JSON", () => {
    const env = buildSignalingEnvelope(SID, "offer", offer, NOW);
    const json = JSON.stringify(env);
    const decoded = decodeSignalingEnvelope(json, {
      expectedSessionId: SID,
      expectedKind: "offer",
      now: NOW,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.envelope.kind).toBe("offer");
      expect(decoded.envelope.signal.kind).toBe("offer");
    }
  });

  it("round-trips answer / bye through Buffer payload", () => {
    for (const [kind, signal] of [
      ["answer", answer],
      ["bye", bye],
    ] as const) {
      const env = buildSignalingEnvelope(SID, kind, signal, NOW);
      const buf = Buffer.from(JSON.stringify(env), "utf8");
      const decoded = decodeSignalingEnvelope(buf, {
        expectedSessionId: SID,
        expectedKind: kind,
        now: NOW,
      });
      expect(decoded.ok).toBe(true);
    }
  });

  it("round-trips ICE candidate envelope with candidateId", () => {
    const env = buildIceCandidateEnvelope(SID, "cand-01", ice, NOW);
    const decoded = decodeSignalingEnvelope(JSON.stringify(env), {
      expectedSessionId: SID,
      expectedKind: "ice",
      now: NOW,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.envelope.candidateId).toBe("cand-01");
    }
  });

  it("rejects mismatched kind from the path", () => {
    const env = buildSignalingEnvelope(SID, "offer", offer, NOW);
    const decoded = decodeSignalingEnvelope(JSON.stringify(env), {
      expectedSessionId: SID,
      expectedKind: "answer",
      now: NOW,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("kind_mismatch");
  });

  it("rejects mismatched sessionId from the path", () => {
    const env = buildSignalingEnvelope(SID, "offer", offer, NOW);
    const decoded = decodeSignalingEnvelope(JSON.stringify(env), {
      expectedSessionId: "sess-otherid",
      expectedKind: "offer",
      now: NOW,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("session_mismatch");
  });

  it("rejects stale envelopes past TTL", () => {
    const env = buildSignalingEnvelope(SID, "offer", offer, NOW);
    const decoded = decodeSignalingEnvelope(JSON.stringify(env), {
      expectedSessionId: SID,
      expectedKind: "offer",
      now: NOW + SIGNALING_CHANNEL_TTL_MS + 1,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("stale");
  });

  it("rejects malformed JSON", () => {
    const decoded = decodeSignalingEnvelope("{not-json", {
      expectedSessionId: SID,
      expectedKind: "offer",
      now: NOW,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("bad_json");
  });

  it("rejects oversized payload", () => {
    const huge = "x".repeat(20 * 1024);
    const decoded = decodeSignalingEnvelope(huge, {
      expectedSessionId: SID,
      expectedKind: "offer",
      now: NOW,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("oversized");
  });

  it("rejects bad shape (missing v / wrong v)", () => {
    const bad = { v: 99, ts: NOW, sessionId: SID, kind: "offer", signal: offer };
    const decoded = decodeSignalingEnvelope(JSON.stringify(bad), {
      expectedSessionId: SID,
      expectedKind: "offer",
      now: NOW,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("bad_shape");
  });
});
