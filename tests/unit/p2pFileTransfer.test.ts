import { describe, expect, it } from "vitest";
import {
  createChunkAssembler,
  decodeFileChunkPayload,
  decodeManifestPayload,
  encodeFileChunkPayload,
  encodeManifestPayload,
  P2P_DEFAULT_CHUNK_SIZE_BYTES,
  P2P_FILE_CHUNK_HEADER_BYTES,
  planP2PFileChunks,
  type P2PFileManifest,
} from "../../src/core/p2pFileTransfer.js";

const TID = "transfer-123abc";

function fillBytes(n: number, byte = 0x42): Uint8Array {
  const a = new Uint8Array(n);
  a.fill(byte);
  return a;
}

describe("planP2PFileChunks", () => {
  it("splits a buffer into chunks of the configured size with the last chunk being the remainder", () => {
    const content = fillBytes(40 * 1024);
    const plan = planP2PFileChunks(content, { transferId: TID, relPath: "foo.bin" });
    expect(plan.manifest.totalChunks).toBe(Math.ceil(40 * 1024 / P2P_DEFAULT_CHUNK_SIZE_BYTES));
    expect(plan.manifest.totalBytes).toBe(40 * 1024);
    expect(plan.chunks.reduce((sum, c) => sum + c.byteLength, 0)).toBe(40 * 1024);
    expect(plan.chunks[0]?.byteLength).toBe(P2P_DEFAULT_CHUNK_SIZE_BYTES);
    expect(plan.chunks.at(-1)?.byteLength).toBe(40 * 1024 - 2 * P2P_DEFAULT_CHUNK_SIZE_BYTES);
  });

  it("emits exactly one zero-length chunk for an empty file", () => {
    const plan = planP2PFileChunks(new Uint8Array(0), { transferId: TID, relPath: "empty.txt" });
    expect(plan.manifest.totalChunks).toBe(1);
    expect(plan.manifest.totalBytes).toBe(0);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]?.byteLength).toBe(0);
  });

  it("rejects invalid transferId", () => {
    expect(() => planP2PFileChunks(new Uint8Array(0), { transferId: "../etc", relPath: "x" })).toThrow(
      /invalid transferId/,
    );
  });

  it("computes a SHA-256 hash that matches recomputation by the assembler", () => {
    const content = fillBytes(50, 0xab);
    const plan = planP2PFileChunks(content, { transferId: TID, relPath: "x.bin", chunkSize: 16 });
    const asm = createChunkAssembler(plan.manifest);
    plan.chunks.forEach((chunk, i) => {
      asm.applyChunk(i, chunk);
    });
    expect(asm.isComplete()).toBe(true);
    const fin = asm.finalize();
    expect(fin.ok).toBe(true);
    if (fin.ok) {
      expect(fin.hashOk).toBe(true);
      expect(Buffer.from(fin.content).equals(Buffer.from(content))).toBe(true);
    }
  });

  it("rejects file > P2P_MAX_TRANSFER_BYTES", () => {
    // We do not allocate 64 MB+; instead, mock by directly checking the
    // boundary path with a small over-limit value via chunkSize manipulation
    // is not possible, so use a fake byteLength via a backing ArrayBuffer.
    // Easier: test that the limit path is reachable by forcing an oversized
    // (but cheap) buffer. We allocate 65 MB of zeros.
    const big = new Uint8Array(65 * 1024 * 1024);
    expect(() => planP2PFileChunks(big, { transferId: TID, relPath: "big" })).toThrow(/file too large/);
  });
});

describe("encodeManifestPayload + decodeManifestPayload", () => {
  it("round-trips a valid manifest", () => {
    const plan = planP2PFileChunks(fillBytes(20), { transferId: TID, relPath: "a.txt", chunkSize: 8 });
    const enc = encodeManifestPayload(plan.manifest);
    const dec = decodeManifestPayload(enc);
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      expect(dec.manifest).toEqual(plan.manifest);
    }
  });

  it("rejects oversized manifest payload", () => {
    const huge = new Uint8Array(20 * 1024);
    const dec = decodeManifestPayload(huge);
    expect(dec.ok).toBe(false);
    if (!dec.ok) expect(dec.reason).toBe("oversized");
  });

  it("rejects bad JSON", () => {
    const bad = new TextEncoder().encode("{not-json");
    const dec = decodeManifestPayload(bad);
    expect(dec.ok).toBe(false);
    if (!dec.ok) expect(dec.reason).toBe("bad_json");
  });

  it("rejects shape with missing fields", () => {
    const bad = new TextEncoder().encode(JSON.stringify({ v: 1 }));
    const dec = decodeManifestPayload(bad);
    expect(dec.ok).toBe(false);
    if (!dec.ok) expect(dec.reason).toBe("bad_shape");
  });

  it("rejects traversal, absolute and drive-letter relPath (B15)", () => {
    const base: P2PFileManifest = {
      v: 1,
      transferId: TID,
      relPath: "a.txt",
      totalChunks: 1,
      totalBytes: 0,
      hash: "a".repeat(64),
      chunkSize: 16,
    };
    for (const relPath of [
      "../../../.ssh/authorized_keys",
      "..",
      "a/../../b.txt",
      "/etc/passwd",
      "C:/Windows/system32/drivers/etc/hosts",
      "..\\..\\evil.txt",
    ]) {
      const dec = decodeManifestPayload(new TextEncoder().encode(JSON.stringify({ ...base, relPath })));
      expect(dec.ok, relPath).toBe(false);
      if (!dec.ok) expect(dec.reason, relPath).toBe("unsafe_path");
    }
  });

  it("normalises a benign relPath instead of trusting the wire form", () => {
    const m: P2PFileManifest = {
      v: 1,
      transferId: TID,
      relPath: "./src//deep/./file.ts",
      totalChunks: 1,
      totalBytes: 0,
      hash: "a".repeat(64),
      chunkSize: 16,
    };
    const dec = decodeManifestPayload(new TextEncoder().encode(JSON.stringify(m)));
    expect(dec.ok).toBe(true);
    if (dec.ok) expect(dec.manifest.relPath).toBe("src/deep/file.ts");
  });

  it("rejects bad hash format", () => {
    const m: P2PFileManifest = {
      v: 1,
      transferId: TID,
      relPath: "a.txt",
      totalChunks: 1,
      totalBytes: 0,
      hash: "not-a-hex-256-bit",
      chunkSize: 16,
    };
    const dec = decodeManifestPayload(new TextEncoder().encode(JSON.stringify(m)));
    expect(dec.ok).toBe(false);
    if (!dec.ok) expect(dec.reason).toBe("bad_shape");
  });
});

describe("encodeFileChunkPayload + decodeFileChunkPayload", () => {
  it("round-trips a chunk with index", () => {
    const chunk = fillBytes(100, 0x77);
    const encoded = encodeFileChunkPayload(7, chunk);
    expect(encoded.byteLength).toBe(P2P_FILE_CHUNK_HEADER_BYTES + chunk.byteLength);
    const decoded = decodeFileChunkPayload(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.chunkIndex).toBe(7);
      expect(decoded.chunk.byteLength).toBe(chunk.byteLength);
      expect(Buffer.from(decoded.chunk).equals(Buffer.from(chunk))).toBe(true);
    }
  });

  it("rejects header-too-short payload", () => {
    const decoded = decodeFileChunkPayload(new Uint8Array(4));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("header_short");
  });

  it("rejects length-mismatch payload", () => {
    const corrupt = new Uint8Array(P2P_FILE_CHUNK_HEADER_BYTES + 4);
    const view = new DataView(corrupt.buffer);
    view.setUint32(0, 0, false);
    view.setUint32(4, 99, false); // declares 99 but only 4 bytes follow
    const decoded = decodeFileChunkPayload(corrupt);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("length_mismatch");
  });
});

describe("createChunkAssembler", () => {
  it("rebuilds the file from in-order chunks", () => {
    const content = fillBytes(48, 0x55);
    const plan = planP2PFileChunks(content, { transferId: TID, relPath: "f", chunkSize: 16 });
    const asm = createChunkAssembler(plan.manifest);
    plan.chunks.forEach((chunk, i) => {
      asm.applyChunk(i, chunk);
    });
    const fin = asm.finalize();
    expect(fin.ok).toBe(true);
    if (fin.ok) expect(fin.hashOk).toBe(true);
  });

  it("rebuilds the file when chunks arrive out of order", () => {
    const content = fillBytes(48, 0x55);
    const plan = planP2PFileChunks(content, { transferId: TID, relPath: "f", chunkSize: 16 });
    const asm = createChunkAssembler(plan.manifest);
    const indices = plan.chunks.map((_, i) => i).reverse();
    for (const i of indices) {
      asm.applyChunk(i, plan.chunks[i]);
    }
    const fin = asm.finalize();
    expect(fin.ok).toBe(true);
    if (fin.ok) expect(fin.hashOk).toBe(true);
  });

  it("ignores duplicate chunk frames idempotently", () => {
    const content = fillBytes(32, 0x10);
    const plan = planP2PFileChunks(content, { transferId: TID, relPath: "f", chunkSize: 16 });
    const asm = createChunkAssembler(plan.manifest);
    asm.applyChunk(0, plan.chunks[0]);
    asm.applyChunk(0, plan.chunks[0]); // duplicate
    expect(asm.isComplete()).toBe(false);
    asm.applyChunk(1, plan.chunks[1]);
    expect(asm.isComplete()).toBe(true);
  });

  it("rejects out-of-range chunkIndex", () => {
    const plan = planP2PFileChunks(fillBytes(10), { transferId: TID, relPath: "f", chunkSize: 5 });
    const asm = createChunkAssembler(plan.manifest);
    const r = asm.applyChunk(99, new Uint8Array(5));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("chunk_index_out_of_range");
  });

  it("returns hashOk=false when the rebuilt content does not match manifest hash", () => {
    const content = fillBytes(20, 0x10);
    const plan = planP2PFileChunks(content, { transferId: TID, relPath: "f", chunkSize: 10 });
    const asm = createChunkAssembler(plan.manifest);
    asm.applyChunk(0, plan.chunks[0]);
    asm.applyChunk(1, fillBytes(plan.chunks[1].byteLength, 0xff)); // tampered
    const fin = asm.finalize();
    expect(fin.ok).toBe(true);
    if (fin.ok) expect(fin.hashOk).toBe(false);
  });

  it("finalize() returns 'incomplete' when not all chunks delivered", () => {
    const plan = planP2PFileChunks(fillBytes(20), { transferId: TID, relPath: "f", chunkSize: 10 });
    const asm = createChunkAssembler(plan.manifest);
    asm.applyChunk(0, plan.chunks[0]);
    const fin = asm.finalize();
    expect(fin.ok).toBe(false);
    if (!fin.ok) expect(fin.reason).toBe("incomplete");
  });
});
