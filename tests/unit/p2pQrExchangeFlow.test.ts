import { describe, expect, it } from "vitest";
import { createQrExchangeFlow } from "../../src/core/p2pQrExchangeFlow.js";
import { planQrChunks, encodeQrChunkLine } from "../../src/core/p2pQrExchange.js";

const SESSION_A = "session1234abcd";
const SESSION_B = "differntses99zz";

const SMALL_OFFER = JSON.stringify({ kind: "offer", sdp: "v=0\r\n…" });
const SMALL_ANSWER = JSON.stringify({ kind: "answer", sdp: "v=0\r\n…" });

describe("createQrExchangeFlow — inviter happy path (small payloads)", () => {
  it("starts in render_offer with one outbound chunk for a small payload", () => {
    const flow = createQrExchangeFlow({
      role: "inviter",
      localPayload: SMALL_OFFER,
      sessionId: SESSION_A,
    });
    expect(flow.state.phase).toBe("render_offer");
    expect(flow.state.outboundChunks.length).toBe(1);
    expect(flow.currentOutboundLine()).not.toBeNull();
  });

  it("acknowledgeOutboundDelivered moves render_offer → await_answer_scan", () => {
    const flow = createQrExchangeFlow({
      role: "inviter",
      localPayload: SMALL_OFFER,
      sessionId: SESSION_A,
    });
    flow.acknowledgeOutboundDelivered();
    expect(flow.state.phase).toBe("await_answer_scan");
    expect(flow.currentOutboundLine()).toBeNull();
  });

  it("scan of full peer answer advances phase via decode_answer → done", () => {
    const flow = createQrExchangeFlow({
      role: "inviter",
      localPayload: SMALL_OFFER,
      sessionId: SESSION_A,
    });
    flow.acknowledgeOutboundDelivered();
    const peerChunks = planQrChunks(SMALL_ANSWER, SESSION_A);
    const r1 = flow.acceptScannedLine(encodeQrChunkLine(peerChunks[0]));
    expect(r1.ok).toBe(true);
    expect(flow.state.phase).toBe("decode_answer");
    expect(flow.state.inboundPayload).toBe(SMALL_ANSWER);
    flow.complete();
    expect(flow.state.phase).toBe("done");
  });
});

describe("createQrExchangeFlow — invitee happy path", () => {
  it("starts in await_offer_scan and only renders after offer fully scanned", () => {
    const flow = createQrExchangeFlow({
      role: "invitee",
      localPayload: SMALL_ANSWER,
      sessionId: SESSION_A,
    });
    expect(flow.state.phase).toBe("await_offer_scan");
    expect(flow.currentOutboundLine()).toBeNull();
    const offerChunks = planQrChunks(SMALL_OFFER, SESSION_A);
    flow.acceptScannedLine(encodeQrChunkLine(offerChunks[0]));
    expect(flow.state.phase).toBe("render_answer");
    expect(flow.currentOutboundLine()).not.toBeNull();
  });

  it("acknowledgeOutboundDelivered moves render_answer → await_ack", () => {
    const flow = createQrExchangeFlow({
      role: "invitee",
      localPayload: SMALL_ANSWER,
      sessionId: SESSION_A,
    });
    const offerChunks = planQrChunks(SMALL_OFFER, SESSION_A);
    flow.acceptScannedLine(encodeQrChunkLine(offerChunks[0]));
    flow.acknowledgeOutboundDelivered();
    expect(flow.state.phase).toBe("await_ack");
    flow.complete();
    expect(flow.state.phase).toBe("done");
  });
});

describe("createQrExchangeFlow — multi-chunk payloads", () => {
  it("inviter rotates outbound cursor with nextOutboundChunk", () => {
    const longPayload = "x".repeat(8_000);
    const flow = createQrExchangeFlow({
      role: "inviter",
      localPayload: longPayload,
      sessionId: SESSION_A,
      chunkLen: 1500,
    });
    expect(flow.state.outboundChunks.length).toBeGreaterThan(1);
    const first = flow.currentOutboundLine();
    const second = flow.nextOutboundChunk();
    expect(second).not.toBe(first);
    // Wraps at end.
    while (flow.state.outboundCursor !== 0) {
      flow.nextOutboundChunk();
    }
    expect(flow.currentOutboundLine()).toBe(first);
  });

  it("invitee accumulates inbound chunks and only advances when complete", () => {
    const longOffer = "y".repeat(6_000);
    const offerChunks = planQrChunks(longOffer, SESSION_A, 1500);
    expect(offerChunks.length).toBeGreaterThanOrEqual(2);
    const flow = createQrExchangeFlow({
      role: "invitee",
      localPayload: SMALL_ANSWER,
      sessionId: SESSION_A,
    });
    const r1 = flow.acceptScannedLine(encodeQrChunkLine(offerChunks[0]));
    if (!r1.ok) throw new Error("expected ok");
    expect(r1.complete).toBe(false);
    expect(flow.state.phase).toBe("await_offer_scan");
    const r2 = flow.acceptScannedLine(encodeQrChunkLine(offerChunks[1]));
    if (!r2.ok) throw new Error("expected ok");
    if (offerChunks.length === 2) {
      expect(flow.state.phase).toBe("render_answer");
      expect(flow.state.inboundPayload).toBe(longOffer);
    }
  });
});

describe("createQrExchangeFlow — rejection paths", () => {
  it("rejects scan during render_offer (wrong_phase)", () => {
    const flow = createQrExchangeFlow({
      role: "inviter",
      localPayload: SMALL_OFFER,
      sessionId: SESSION_A,
    });
    const peerChunks = planQrChunks(SMALL_ANSWER, SESSION_A);
    const r = flow.acceptScannedLine(encodeQrChunkLine(peerChunks[0]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("wrong_phase");
  });

  it("rejects scan with mismatched session id", () => {
    const flow = createQrExchangeFlow({
      role: "invitee",
      localPayload: SMALL_ANSWER,
      sessionId: SESSION_A,
    });
    const offerA = planQrChunks(SMALL_OFFER, SESSION_A);
    const offerB = planQrChunks(SMALL_OFFER, SESSION_B);
    flow.acceptScannedLine(encodeQrChunkLine(offerA[0]));
    // After first chunk, assembler is locked to SESSION_A.
    // But this test path needs more chunks; instead use fresh flow:
    const flow2 = createQrExchangeFlow({
      role: "invitee",
      localPayload: SMALL_ANSWER,
      sessionId: SESSION_A,
    });
    flow2.acceptScannedLine(encodeQrChunkLine(planQrChunks("x".repeat(3000), SESSION_A, 1500)[0]));
    const r = flow2.acceptScannedLine(encodeQrChunkLine(offerB[0]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("session_mismatch");
  });

  it("rejects malformed line as bad_format", () => {
    const flow = createQrExchangeFlow({
      role: "invitee",
      localPayload: SMALL_ANSWER,
      sessionId: SESSION_A,
    });
    const r = flow.acceptScannedLine("not-a-qr-payload");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_format");
  });
});

describe("createQrExchangeFlow — currentOutboundLine after complete", () => {
  it("returns null when phase is done", () => {
    const flow = createQrExchangeFlow({
      role: "inviter",
      localPayload: SMALL_OFFER,
      sessionId: SESSION_A,
    });
    flow.complete();
    expect(flow.state.phase).toBe("done");
    expect(flow.currentOutboundLine()).toBeNull();
    expect(flow.nextOutboundChunk()).toBeNull();
  });
});
