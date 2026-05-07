import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decodeP2PFrame,
  encodeP2PFrame,
  P2P_FRAME_HEADER_BYTES,
  P2P_FRAME_VERSION,
} from "../../src/core/p2pCryptoEnvelope.js";

const KEY = randomBytes(32);

describe("p2pCryptoEnvelope — encode / decode round-trip", () => {
  it("round-trips for each known type", () => {
    for (const type of ["file_chunk", "manifest", "ack", "bye"] as const) {
      const payload = Buffer.from(`hello ${type}`);
      const frame = encodeP2PFrame(KEY, { type, seq: 1, payload });
      const out = decodeP2PFrame(KEY, frame);
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.type).toBe(type);
        expect(out.seq).toBe(1);
        expect(out.payload.toString()).toBe(payload.toString());
      }
    }
  });

  it("encrypted body changes between calls (random IV)", () => {
    const payload = Buffer.from("identical");
    const a = encodeP2PFrame(KEY, { type: "file_chunk", seq: 0, payload });
    const b = encodeP2PFrame(KEY, { type: "file_chunk", seq: 0, payload });
    // Header (8 bytes) is deterministic; the body must differ because of IV.
    expect(a.subarray(0, P2P_FRAME_HEADER_BYTES)).toEqual(b.subarray(0, P2P_FRAME_HEADER_BYTES));
    expect(a.subarray(P2P_FRAME_HEADER_BYTES)).not.toEqual(b.subarray(P2P_FRAME_HEADER_BYTES));
  });

  it("preserves seq across the wire", () => {
    const frame = encodeP2PFrame(KEY, { type: "ack", seq: 0xdeadbeef, payload: Buffer.alloc(0) });
    const out = decodeP2PFrame(KEY, frame);
    expect(out.ok && out.seq).toBe(0xdeadbeef);
  });
});

describe("p2pCryptoEnvelope — strict decoder", () => {
  it("rejects key of wrong length on encode and decode", () => {
    const wrong = randomBytes(16);
    expect(() => encodeP2PFrame(wrong, { type: "ack", seq: 0, payload: Buffer.alloc(0) })).toThrow();
    const goodFrame = encodeP2PFrame(KEY, { type: "ack", seq: 0, payload: Buffer.alloc(0) });
    expect(decodeP2PFrame(wrong, goodFrame).ok).toBe(false);
  });

  it("rejects seq outside u32 range on encode", () => {
    expect(() => encodeP2PFrame(KEY, { type: "ack", seq: -1, payload: Buffer.alloc(0) })).toThrow();
    expect(() => encodeP2PFrame(KEY, { type: "ack", seq: 2 ** 32, payload: Buffer.alloc(0) })).toThrow();
    expect(() =>
      encodeP2PFrame(KEY, { type: "ack", seq: 1.5, payload: Buffer.alloc(0) }),
    ).toThrow();
  });

  it("rejects frame shorter than header", () => {
    const out = decodeP2PFrame(KEY, Buffer.from([1, 2, 3]));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("shorter than header");
  });

  it("rejects unsupported version", () => {
    const frame = encodeP2PFrame(KEY, { type: "ack", seq: 0, payload: Buffer.alloc(0) });
    const tampered = Buffer.from(frame);
    tampered.writeUInt8(P2P_FRAME_VERSION + 1, 0);
    const out = decodeP2PFrame(KEY, tampered);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("unsupported version");
  });

  it("rejects unknown type code", () => {
    const frame = encodeP2PFrame(KEY, { type: "ack", seq: 0, payload: Buffer.alloc(0) });
    const tampered = Buffer.from(frame);
    tampered.writeUInt8(99, 1);
    const out = decodeP2PFrame(KEY, tampered);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("unknown type");
  });

  it("rejects non-zero reserved bits (forward-compat lock)", () => {
    const frame = encodeP2PFrame(KEY, { type: "ack", seq: 0, payload: Buffer.alloc(0) });
    const tampered = Buffer.from(frame);
    tampered.writeUInt16LE(0xffff, 6);
    const out = decodeP2PFrame(KEY, tampered);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("reserved");
  });

  it("rejects body tampering via authTag", () => {
    const frame = encodeP2PFrame(KEY, {
      type: "file_chunk",
      seq: 7,
      payload: Buffer.from("important"),
    });
    const tampered = Buffer.from(frame);
    // flip a bit in the encrypted body
    tampered[tampered.length - 1] ^= 0x01;
    const out = decodeP2PFrame(KEY, tampered);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("decrypt failed");
  });

  it("rejects expectedSeq mismatch", () => {
    const frame = encodeP2PFrame(KEY, { type: "ack", seq: 5, payload: Buffer.alloc(0) });
    const out = decodeP2PFrame(KEY, frame, 6);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("seq mismatch");
  });

  it("rejects decryption with a different key", () => {
    const frame = encodeP2PFrame(KEY, { type: "ack", seq: 0, payload: Buffer.from("x") });
    const out = decodeP2PFrame(randomBytes(32), frame);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("decrypt failed");
  });
});
