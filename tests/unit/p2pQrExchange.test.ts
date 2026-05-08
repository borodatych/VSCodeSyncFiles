import { describe, expect, it } from "vitest";
import {
  createQrAssembler,
  encodeQrChunkLine,
  parseQrChunkLine,
  planQrChunks,
  QR_CHUNK_PAYLOAD_BASE64_LIMIT,
} from "../../src/core/p2pQrExchange.js";

const SID = "qr-session-12345";

describe("planQrChunks", () => {
  it("splits a small payload into a single chunk", () => {
    const chunks = planQrChunks("hello world", SID);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.idx).toBe(1);
    expect(chunks[0]?.total).toBe(1);
  });

  it("splits a large payload into N chunks of bounded base64 size", () => {
    const big = "x".repeat(10_000);
    const chunks = planQrChunks(big, SID, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.payloadB64Segment.length).toBeLessThanOrEqual(200);
    }
    expect(chunks[chunks.length - 1]?.idx).toBe(chunks.length);
  });

  it("rejects bad sessionId", () => {
    expect(() => planQrChunks("x", "../escape")).toThrow();
    expect(() => planQrChunks("x", "short")).toThrow();
  });

  it("rejects chunkLen out of range", () => {
    expect(() => planQrChunks("x", SID, 10)).toThrow();
    expect(() => planQrChunks("x", SID, 99999)).toThrow();
  });
});

describe("encode / parse round-trip", () => {
  it("encodeQrChunkLine + parseQrChunkLine round-trip", () => {
    const c = { sessionId: SID, idx: 2, total: 5, payloadB64Segment: "AAAA" };
    const line = encodeQrChunkLine(c);
    const r = parseQrChunkLine(line);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chunk).toEqual(c);
  });

  it("rejects wrong protocol tag", () => {
    const r = parseQrChunkLine(`OTHER|${SID}|1|1|AAAA`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_protocol");
  });

  it("rejects bad index numbers", () => {
    expect(parseQrChunkLine(`VSS1|${SID}|0|3|x`).ok).toBe(false);
    expect(parseQrChunkLine(`VSS1|${SID}|5|3|x`).ok).toBe(false);
    expect(parseQrChunkLine(`VSS1|${SID}|abc|3|x`).ok).toBe(false);
  });

  it("rejects bad sessionId", () => {
    const r = parseQrChunkLine(`VSS1|short|1|1|x`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_session");
  });
});

describe("createQrAssembler", () => {
  it("reassembles chunks regardless of arrival order", () => {
    const original = JSON.stringify({ a: 1, b: "x".repeat(500) });
    const chunks = planQrChunks(original, SID, 200);
    const a = createQrAssembler();
    // shuffle reverse
    for (let i = chunks.length - 1; i >= 0; i--) {
      const r = a.pushChunk(encodeQrChunkLine(chunks[i]));
      expect(r.ok).toBe(true);
    }
    expect(a.isComplete()).toBe(true);
    expect(a.finalize()).toBe(original);
  });

  it("rejects chunks from a different session", () => {
    const a = createQrAssembler();
    const ok = a.pushChunk(encodeQrChunkLine({ sessionId: SID, idx: 1, total: 2, payloadB64Segment: "AAAA" }));
    expect(ok.ok).toBe(true);
    const bad = a.pushChunk(
      encodeQrChunkLine({ sessionId: "other-session-x", idx: 2, total: 2, payloadB64Segment: "BBBB" }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("session_mismatch");
  });

  it("rejects parse errors and reports parse reason", () => {
    const a = createQrAssembler();
    const r = a.pushChunk("not-a-valid-line");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_format");
  });

  it("finalize throws when incomplete", () => {
    const a = createQrAssembler();
    a.pushChunk(encodeQrChunkLine({ sessionId: SID, idx: 1, total: 2, payloadB64Segment: "AAAA" }));
    expect(() => a.finalize()).toThrow();
  });

  it("QR_CHUNK_PAYLOAD_BASE64_LIMIT keeps a single chunk under 2 KB once base64-decoded", () => {
    expect(QR_CHUNK_PAYLOAD_BASE64_LIMIT).toBeLessThan(2048);
  });
});
