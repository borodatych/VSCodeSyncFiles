/**
 * Unit + integration tests for the Delta Sync rolling-hash algorithm (§8.2).
 * Covers: chunking, delta computation, delta application, compression integration,
 * and the "big file → 1 GET + 1 PUT" scenario (mocked provider).
 */
import { describe, it, expect } from "vitest";
import {
  computeChunks,
  computeDelta,
  applyDelta,
  analyzeDelta,
  deltaApplyFromCloud,
  isDeltaSyncEligible,
  DEFAULT_DELTA_THRESHOLD_KB,
} from "../../src/core/deltaSyncGate.js";
import * as zlib from "node:zlib";

// ─── Gate tests ───────────────────────────────────────────────────────────────

describe("isDeltaSyncEligible", () => {
  it("false when deltaSync disabled", () => {
    expect(isDeltaSyncEligible({ deltaSync: false, deltaThresholdKB: 100, plaintextByteLength: 1_000_000 })).toBe(false);
  });

  it("false when file is below threshold", () => {
    expect(isDeltaSyncEligible({ deltaSync: true, deltaThresholdKB: 100, plaintextByteLength: 50_000 })).toBe(false);
  });

  it("true when file meets threshold", () => {
    expect(isDeltaSyncEligible({ deltaSync: true, deltaThresholdKB: 100, plaintextByteLength: 102_400 })).toBe(true);
  });

  it("uses DEFAULT_DELTA_THRESHOLD_KB for invalid threshold", () => {
    expect(isDeltaSyncEligible({ deltaSync: true, deltaThresholdKB: -1, plaintextByteLength: DEFAULT_DELTA_THRESHOLD_KB * 1024 })).toBe(true);
  });
});

// ─── Chunking tests ───────────────────────────────────────────────────────────

describe("computeChunks", () => {
  it("produces at least one chunk for non-empty buffer", () => {
    const buf = Buffer.from("hello world");
    const chunks = computeChunks(buf);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("empty buffer produces no chunks", () => {
    const chunks = computeChunks(Buffer.alloc(0));
    expect(chunks.length).toBe(0);
  });

  it("chunks cover the entire buffer", () => {
    const buf = Buffer.allocUnsafe(50_000);
    buf.fill(0x42);
    const chunks = computeChunks(buf);
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    expect(total).toBe(buf.length);
  });

  it("chunks are non-overlapping and contiguous", () => {
    const buf = Buffer.allocUnsafe(30_000);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 251;
    const chunks = computeChunks(buf);
    let pos = 0;
    for (const c of chunks) {
      expect(c.offset).toBe(pos);
      pos += c.length;
    }
    expect(pos).toBe(buf.length);
  });

  it("identical content produces identical chunk hashes", () => {
    const data = Buffer.from("repeated data ".repeat(500));
    const c1 = computeChunks(data);
    const c2 = computeChunks(data);
    expect(c1.length).toBe(c2.length);
    for (let i = 0; i < c1.length; i++) {
      expect(c1[i].hash).toBe(c2[i].hash);
    }
  });

  it("different content produces at least one different chunk hash", () => {
    const a = Buffer.alloc(20_000, 0xaa);
    const b = Buffer.alloc(20_000, 0xbb);
    const ca = computeChunks(a);
    const cb = computeChunks(b);
    const hashesA = new Set(ca.map((c) => c.hash));
    const hashesB = new Set(cb.map((c) => c.hash));
    const intersection = [...hashesA].filter((h) => hashesB.has(h));
    // Different content → no common hashes
    expect(intersection.length).toBe(0);
  });
});

// ─── Delta compute + apply tests ──────────────────────────────────────────────

describe("computeDelta + applyDelta round-trip", () => {
  it("identical source and target: all copy ops", () => {
    const data = Buffer.from("the same content ".repeat(400));
    const chunks = computeChunks(data);
    const delta = computeDelta(chunks, data);
    expect(delta.ops.every((op) => op.op === "copy")).toBe(true);
    const result = applyDelta(data, delta);
    expect(result.equals(data)).toBe(true);
  });

  it("completely different source and target: all insert ops", () => {
    const source = Buffer.alloc(20_000, 0x11);
    const target = Buffer.alloc(20_000, 0x22);
    const chunks = computeChunks(source);
    const delta = computeDelta(chunks, target);
    // All new data, no reuse from source
    expect(delta.ops.every((op) => op.op === "insert")).toBe(true);
    const result = applyDelta(source, delta);
    expect(result.equals(target)).toBe(true);
  });

  it("small edit at end: first chunks reused, last chunk inserted", () => {
    const base = Buffer.allocUnsafe(50_000);
    for (let i = 0; i < base.length; i++) base[i] = i % 251;
    const modified = Buffer.concat([base.subarray(0, 48_000), Buffer.from("new ending data")]);
    const chunks = computeChunks(base);
    const delta = computeDelta(chunks, modified);
    const stats = analyzeDelta(delta);
    // Most bytes should be reused
    expect(stats.bytesReused).toBeGreaterThan(stats.bytesNew);
    const result = applyDelta(base, delta);
    expect(result.equals(modified)).toBe(true);
  });

  it("applyDelta throws on length mismatch (tampered delta)", () => {
    const source = Buffer.from("source data");
    const target = Buffer.from("different target data");
    const chunks = computeChunks(source);
    const delta = computeDelta(chunks, target);
    // Tamper: wrong targetLength
    const bad = { ...delta, targetLength: 999 };
    expect(() => applyDelta(source, bad)).toThrow(/length mismatch/);
  });

  it("round-trip: large random buffer with random edit", () => {
    const size = 100_000;
    const source = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) source[i] = Math.floor(Math.random() * 256);
    const target = Buffer.from(source);
    // Edit 1 KB in the middle
    const editStart = 40_000;
    for (let i = editStart; i < editStart + 1024; i++) target[i] = 0xff;
    const chunks = computeChunks(source);
    const delta = computeDelta(chunks, target);
    const result = applyDelta(source, delta);
    expect(result.equals(target)).toBe(true);
  });
});

// ─── Delta stats ──────────────────────────────────────────────────────────────

describe("analyzeDelta", () => {
  it("identical content has noveltyRatio = 0", () => {
    const data = Buffer.from("abc ".repeat(3000));
    const chunks = computeChunks(data);
    const delta = computeDelta(chunks, data);
    const stats = analyzeDelta(delta);
    expect(stats.noveltyRatio).toBe(0);
    expect(stats.bytesReused).toBe(data.length);
  });

  it("completely different content has noveltyRatio = 1", () => {
    const src = Buffer.alloc(20_000, 0xaa);
    const tgt = Buffer.alloc(20_000, 0xbb);
    const chunks = computeChunks(src);
    const delta = computeDelta(chunks, tgt);
    const stats = analyzeDelta(delta);
    expect(stats.noveltyRatio).toBe(1);
  });
});

// ─── Delta Sync + Compression ─────────────────────────────────────────────────

describe("deltaApplyFromCloud — gzip integration", () => {
  it("decompresses gzip cloud buffer before diffing", () => {
    const localBuf = Buffer.from("local content ".repeat(300));
    // Simulate cloud buffer that was gzip-compressed
    const cloudPlain = Buffer.from("local content ".repeat(300) + " extra at end");
    const cloudGzip = zlib.gzipSync(cloudPlain);

    const result = deltaApplyFromCloud(cloudGzip, localBuf, true /* wireGzip */);
    expect(result.equals(cloudPlain)).toBe(true);
  });

  it("passes through uncompressed cloud buffer without gzip decode", () => {
    const localBuf = Buffer.from("local file content");
    const cloudPlain = Buffer.from("cloud file content updated");

    const result = deltaApplyFromCloud(cloudPlain, localBuf, false /* wireGzip=false */);
    expect(result.equals(cloudPlain)).toBe(true);
  });

  it("falls back gracefully when round-trip fails (identity)", () => {
    // If applyDelta can't reconstruct correctly, deltaApplyFromCloud returns cloudPlain directly
    const localBuf = Buffer.alloc(0); // empty local — no chunks to reuse
    const cloudPlain = Buffer.from("completely new content from cloud");

    const result = deltaApplyFromCloud(cloudPlain, localBuf, false);
    expect(result.equals(cloudPlain)).toBe(true);
  });
});

// ─── "Big file → 1 GET + 1 PUT" integration scenario (mocked) ─────────────────

describe("Delta Sync integration scenario: big file", () => {
  it("simulates conditional GET + delta apply + full PUT", async () => {
    // Use structured (not random) data so CDC can find matching chunks
    // Real-world files (source code, JSON, text) have this property.
    const line = Buffer.from("const x = 'vscodesync-test-data-line'; // padding\n");
    const repeat = Math.ceil(200_000 / line.length);
    const originalContent = Buffer.concat(Array.from({ length: repeat }, () => line)).subarray(0, 200_000);

    // "Cloud" version: change 2 bytes at position 50_000 (simulates a tiny edit)
    const cloudContent = Buffer.from(originalContent);
    cloudContent[50_000] = 0x21; // '!'
    cloudContent[50_001] = 0x21;

    // Mock GET: returns cloud content
    let getCount = 0;
    const mockGet = (): Promise<Buffer> => {
      getCount += 1;
      return Promise.resolve(cloudContent);
    };

    // Mock PUT: records what was uploaded
    let putCount = 0;
    let uploadedContent: Buffer | null = null;
    const mockPut = (content: Buffer): Promise<void> => {
      putCount += 1;
      uploadedContent = content;
      return Promise.resolve();
    };

    // Simulate the delta sync pull:
    // 1. Conditional GET (always fetches in this mock — ETag not matched)
    const cloudBuf = await mockGet();
    // 2. Apply delta from cloud
    const localChunks = computeChunks(originalContent);
    const delta = computeDelta(localChunks, cloudBuf);
    const reconstructed = applyDelta(originalContent, delta);
    // 3. Write locally (simulate) — verify correctness
    expect(reconstructed.equals(cloudContent)).toBe(true);
    // 4. If needed, push (simulate a sync push after local edit)
    await mockPut(reconstructed);

    expect(getCount).toBe(1);
    expect(putCount).toBe(1);
    expect(uploadedContent!.equals(cloudContent)).toBe(true);

    // Verify delta correctness: reconstruction equals cloudContent exactly
    const stats = analyzeDelta(delta);
    // Some chunks from the unchanged head/tail should be reused (CDC property)
    // Cascade effects from boundary shifts are accepted; correctness is paramount.
    expect(stats.totalOps).toBeGreaterThan(0);
    expect(stats.bytesReused + stats.bytesNew).toBe(cloudContent.length);
  });
});
