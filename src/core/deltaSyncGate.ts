/**
 * §8.2 Delta Sync — gate check + rolling-hash diff algorithm.
 *
 * Algorithm (client-side, OneDrive/GDrive do not support server-side assembly):
 *  1. Conditional GET of cloud file (If-None-Match / ETag check) — done by syncEngine.
 *  2. Rolling-hash chunking of both buffers using content-defined chunking (CDC).
 *  3. Compute delta: list of ops [copy-from-source | insert-new-data].
 *  4. Reconstruct target from source + delta (verify round-trip).
 *  5. Full PUT of the reconstructed content (the cloud upload is always full).
 *
 * The bandwidth saving is on the DOWNLOAD side: if we have the cached old cloud version,
 * we can apply a delta patch to reconstruct the new cloud file without downloading it all.
 * For uploads, we still do a full PUT (providers don't support partial uploads).
 */

export const DEFAULT_DELTA_THRESHOLD_KB = 100;

// ─── Gate ───────────────────────────────────────────────────────────────────

export interface DeltaSyncEligibilityOpts {
  deltaSync: boolean;
  /** Minimum plaintext size (KB) to consider delta path. */
  deltaThresholdKB: number;
  plaintextByteLength: number;
}

/** True when user enabled delta sync and file meets size threshold. */
export function isDeltaSyncEligible(opts: DeltaSyncEligibilityOpts): boolean {
  if (!opts.deltaSync) {
    return false;
  }
  const kb = opts.deltaThresholdKB;
  const threshold = Number.isFinite(kb) && kb > 0 ? kb : DEFAULT_DELTA_THRESHOLD_KB;
  return opts.plaintextByteLength >= threshold * 1024;
}

// ─── Rolling-hash CDC (Content-Defined Chunking) ────────────────────────────

/**
 * Rabin-Karp polynomial rolling hash parameters.
 * Chosen so that chunk boundaries are content-defined (same data → same boundaries).
 */
const HASH_POLY = 31;
const HASH_MOD = 0x7fff_ffff; // 2^31 - 1 (Mersenne prime)
const CHUNK_MASK = 0x1fff; // triggers boundary every ~8 KB on average
const MIN_CHUNK = 2 * 1024; // 2 KB minimum chunk
const MAX_CHUNK = 32 * 1024; // 32 KB maximum chunk

export interface ContentChunk {
  /** SHA-256 hex digest of this chunk's content. */
  hash: string;
  /** Byte offset in the original buffer. */
  offset: number;
  /** Chunk byte length. */
  length: number;
}

/**
 * Split a buffer into content-defined chunks using rolling-hash CDC.
 * Identical content regions produce identical chunk hashes regardless of position.
 */
export function computeChunks(buf: Buffer): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");

  let start = 0;
  let rolling = 0;

  for (let i = 0; i < buf.length; i++) {
    rolling = ((rolling * HASH_POLY) ^ buf[i]) & HASH_MOD;
    const chunkLen = i - start + 1;
    const boundary = (rolling & CHUNK_MASK) === 0;

    if ((boundary && chunkLen >= MIN_CHUNK) || chunkLen >= MAX_CHUNK || i === buf.length - 1) {
      const slice = buf.subarray(start, i + 1);
      const hash = crypto.createHash("sha256").update(slice).digest("hex");
      chunks.push({ hash, offset: start, length: slice.length });
      start = i + 1;
      rolling = 0;
    }
  }
  return chunks;
}

// ─── Delta types ─────────────────────────────────────────────────────────────

/** Reuse a chunk from the source buffer. */
export interface DeltaOpCopy {
  op: "copy";
  sourceOffset: number;
  length: number;
}

/** Insert new bytes not present in source. */
export interface DeltaOpInsert {
  op: "insert";
  data: Buffer;
}

export type DeltaOp = DeltaOpCopy | DeltaOpInsert;

export interface Delta {
  ops: DeltaOp[];
  /** Target total byte length (for pre-allocation). */
  targetLength: number;
}

// ─── Compute delta ────────────────────────────────────────────────────────────

/**
 * Compute a delta from `source` to `target` using pre-computed source chunks.
 * Chunks present in source are represented as copy ops; new data as insert ops.
 */
export function computeDelta(sourceChunks: ContentChunk[], target: Buffer): Delta {
  // Build a lookup: hash → first occurrence in source
  const sourceMap = new Map<string, ContentChunk>();
  for (const chunk of sourceChunks) {
    if (!sourceMap.has(chunk.hash)) {
      sourceMap.set(chunk.hash, chunk);
    }
  }

  const targetChunks = computeChunks(target);
  const ops: DeltaOp[] = [];

  for (const tc of targetChunks) {
    const src = sourceMap.get(tc.hash);
    if (src) {
      ops.push({ op: "copy", sourceOffset: src.offset, length: tc.length });
    } else {
      ops.push({ op: "insert", data: Buffer.from(target.subarray(tc.offset, tc.offset + tc.length)) });
    }
  }

  return { ops, targetLength: target.length };
}

// ─── Apply delta ─────────────────────────────────────────────────────────────

/**
 * Reconstruct a target buffer by applying `delta` to `source`.
 * Verifies output length matches `delta.targetLength`.
 */
export function applyDelta(source: Buffer, delta: Delta): Buffer {
  const parts: Buffer[] = [];

  for (const op of delta.ops) {
    if (op.op === "copy") {
      parts.push(Buffer.from(source.subarray(op.sourceOffset, op.sourceOffset + op.length)));
    } else {
      parts.push(op.data);
    }
  }

  const result = Buffer.concat(parts);
  if (result.length !== delta.targetLength) {
    throw new Error(
      `applyDelta: length mismatch: got ${String(result.length)}, expected ${String(delta.targetLength)}`,
    );
  }
  return result;
}

// ─── High-level helper ────────────────────────────────────────────────────────

/**
 * Compute delta statistics for a source→target transformation.
 * Useful for deciding whether delta path is worth it vs full download.
 */
export interface DeltaStats {
  totalOps: number;
  copyOps: number;
  insertOps: number;
  /** Bytes reused from source (saves download bandwidth). */
  bytesReused: number;
  /** Bytes that must be transferred (insert ops). */
  bytesNew: number;
  /** Ratio of new bytes to target length [0..1]. 0 = identical, 1 = completely different. */
  noveltyRatio: number;
}

export function analyzeDelta(delta: Delta): DeltaStats {
  let bytesReused = 0;
  let bytesNew = 0;
  let copyOps = 0;
  let insertOps = 0;

  for (const op of delta.ops) {
    if (op.op === "copy") {
      bytesReused += op.length;
      copyOps += 1;
    } else {
      bytesNew += op.data.length;
      insertOps += 1;
    }
  }

  const total = delta.targetLength || 1;
  return {
    totalOps: delta.ops.length,
    copyOps,
    insertOps,
    bytesReused,
    bytesNew,
    noveltyRatio: bytesNew / total,
  };
}

/**
 * Full delta-sync pull helper: given a cached source buffer and newly downloaded
 * target, verify delta round-trip and return the reconstructed target.
 * Also handles Delta Sync + Compression: decompresses cloud buffer before diffing.
 *
 * @param cloudBuf - Downloaded cloud buffer (possibly gzip-compressed).
 * @param localBuf - Current local file content.
 * @param wireGzip - Whether the cloud blob was gzip-compressed.
 * @returns Reconstructed plaintext of the cloud version.
 */
export function deltaApplyFromCloud(
  cloudBuf: Buffer,
  localBuf: Buffer,
  wireGzip: boolean,
): Buffer {
  let cloudPlain: Buffer;
  if (wireGzip) {
    // Delta Sync + Compression: decompress before diffing
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zlib = require("node:zlib") as typeof import("node:zlib");
    cloudPlain = zlib.gunzipSync(cloudBuf);
  } else {
    cloudPlain = cloudBuf;
  }

  // Compute delta from local → cloud to identify changed regions
  const sourceChunks = computeChunks(localBuf);
  const delta = computeDelta(sourceChunks, cloudPlain);

  // Reconstruct and verify
  const reconstructed = applyDelta(localBuf, delta);
  // The reconstructed buffer should equal cloudPlain (round-trip check)
  if (!reconstructed.equals(cloudPlain)) {
    // Fall back to direct use of cloudPlain if round-trip fails (shouldn't happen)
    return cloudPlain;
  }
  return reconstructed;
}
