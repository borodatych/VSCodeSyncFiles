import { describe, expect, it } from "vitest";
import {
  decodeQrSdpEnvelope,
  encodeQrSdpEnvelope,
  isQrFriendlySize,
} from "../../src/core/p2pQrSdpCompact.js";

const SAMPLE_SDP = [
  "v=0",
  "o=- 7531686942437218 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "a=ice-options:trickle",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:8XCu",
  "a=ice-pwd:wY8WHKqXibu24SXMu+0M+/wL",
  "a=fingerprint:sha-256 AB:CD:EF",
  "a=fingerprint:sha-256 AB:CD:EF",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
].join("\r\n");

describe("encodeQrSdpEnvelope + decodeQrSdpEnvelope", () => {
  it("round-trips a realistic SDP", () => {
    const env = encodeQrSdpEnvelope(SAMPLE_SDP);
    expect(env.payload.startsWith("vsync1.")).toBe(true);
    const dec = decodeQrSdpEnvelope(env.payload);
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      // Minified SDP preserves all functional lines (just dedups noise).
      expect(dec.sdp).toContain("v=0");
      expect(dec.sdp).toContain("a=fingerprint:sha-256 AB:CD:EF");
      expect(dec.sdp).toContain("a=sctp-port:5000");
    }
  });

  it("dedupes repeated fingerprint lines", () => {
    const env = encodeQrSdpEnvelope(SAMPLE_SDP);
    const dec = decodeQrSdpEnvelope(env.payload);
    if (dec.ok) {
      const matches = dec.sdp.match(/a=fingerprint:sha-256 AB:CD:EF/g);
      expect(matches?.length).toBe(1);
    }
  });

  it("drops a=ice-options + a=msid-semantic noise", () => {
    const env = encodeQrSdpEnvelope(SAMPLE_SDP);
    const dec = decodeQrSdpEnvelope(env.payload);
    if (dec.ok) {
      expect(dec.sdp).not.toContain("ice-options");
      expect(dec.sdp).not.toContain("msid-semantic");
    }
  });

  it("compresses typical SDP to under 1KB", () => {
    const env = encodeQrSdpEnvelope(SAMPLE_SDP);
    expect(env.byteSize).toBeLessThan(1024);
  });

  it("decode rejects missing header", () => {
    const r = decodeQrSdpEnvelope("garbage");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_header");
  });

  it("decode rejects malformed base64", () => {
    const r = decodeQrSdpEnvelope("vsync1.???");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["base64_decode_failed", "gunzip_failed"]).toContain(r.error);
  });
});

describe("isQrFriendlySize", () => {
  it("under threshold", () => {
    expect(isQrFriendlySize(500)).toBe(true);
    expect(isQrFriendlySize(1799)).toBe(true);
  });
  it("over threshold", () => {
    expect(isQrFriendlySize(1800)).toBe(true);
    expect(isQrFriendlySize(2500)).toBe(false);
  });
});
