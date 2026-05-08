/**
 * v2.1.4 — pure planner for P2P file transfer over `wrapAuthenticated.sendFrame`.
 *
 * The transport layer (DataChannel + crypto envelope) is in
 * `core/p2pCryptoEnvelope.ts` / `core/p2pDataChannel.ts`. This module provides
 * the *application-layer* shape for splitting a file into manifest + chunks,
 * encoding/decoding both, and reassembling on the receiver.
 *
 * Wire flow:
 *   1. Sender writes a manifest frame:
 *        type=manifest, payload=JSON({ relPath, totalChunks, totalBytes, hash,
 *        chunkSize, transferId }).
 *   2. Sender writes N file_chunk frames:
 *        type=file_chunk, payload=BinaryChunk header + bytes (see
 *        `encodeFileChunkPayload`).
 *   3. Receiver, on each frame, calls `applyChunk` on the assembler.
 *   4. When all chunks received, assembler returns a `complete` result with
 *      the reassembled buffer and the recomputed hash, which the caller
 *      compares against the manifest hash before writing to disk.
 *
 * No `vscode` import. SHA-256 via existing `hashProviders.ts`.
 */
import { createSha256Provider } from "./hashProviders.js";

export const P2P_DEFAULT_CHUNK_SIZE_BYTES = 16 * 1024;
export const P2P_FILE_CHUNK_HEADER_BYTES = 8;
/** Hard upper bound on a single transfer to keep the receiver memory bounded. */
export const P2P_MAX_TRANSFER_BYTES = 64 * 1024 * 1024;

const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface P2PFileManifest {
  v: 1;
  /** UUID-ish per-transfer id; receiver uses it to route chunk frames. */
  transferId: string;
  /** Workspace-relative POSIX path. */
  relPath: string;
  /** Total chunks the sender will emit (≥ 1; for empty files = 1, last chunk = 0 bytes). */
  totalChunks: number;
  /** Sum of all chunk byte lengths. */
  totalBytes: number;
  /** Lowercase hex SHA-256 of the original (uncompressed, unencrypted) buffer. */
  hash: string;
  /** Bytes per chunk (the last chunk may be smaller). */
  chunkSize: number;
}

export interface P2PFileChunkPlan {
  manifest: P2PFileManifest;
  chunks: Uint8Array[];
}

export interface PlanOptions {
  transferId: string;
  relPath: string;
  /** Override default chunk size (16 KB). Useful for tests and tiny test files. */
  chunkSize?: number;
}

function assertTransferId(transferId: string): void {
  if (!TRANSFER_ID_RE.test(transferId)) {
    throw new Error(`p2pFileTransfer: invalid transferId "${transferId}"`);
  }
}

/**
 * Pure planner: split a file buffer into manifest + chunks. Throws on:
 *   - Empty/invalid transferId.
 *   - chunkSize ≤ 0.
 *   - Buffer size > `P2P_MAX_TRANSFER_BYTES`.
 *
 * For an empty file (`content.byteLength === 0`), produces one zero-length
 * chunk so the receiver still has a chunk frame to acknowledge — keeps the
 * happy-path code free of branches on the receiver side.
 */
export function planP2PFileChunks(content: Uint8Array, options: PlanOptions): P2PFileChunkPlan {
  assertTransferId(options.transferId);
  const chunkSize = options.chunkSize ?? P2P_DEFAULT_CHUNK_SIZE_BYTES;
  if (chunkSize <= 0) throw new Error("p2pFileTransfer: chunkSize must be > 0");
  if (content.byteLength > P2P_MAX_TRANSFER_BYTES) {
    throw new Error(
      `p2pFileTransfer: file too large (${String(content.byteLength)} > ${String(P2P_MAX_TRANSFER_BYTES)})`,
    );
  }

  const chunks: Uint8Array[] = [];
  if (content.byteLength === 0) {
    chunks.push(new Uint8Array(0));
  } else {
    for (let off = 0; off < content.byteLength; off += chunkSize) {
      chunks.push(content.subarray(off, Math.min(off + chunkSize, content.byteLength)));
    }
  }

  const sha = createSha256Provider();
  const hash = sha.hash(content);

  const manifest: P2PFileManifest = {
    v: 1,
    transferId: options.transferId,
    relPath: options.relPath,
    totalChunks: chunks.length,
    totalBytes: content.byteLength,
    hash,
    chunkSize,
  };

  return { manifest, chunks };
}

/** Encode a manifest as utf-8 JSON bytes for transport. */
export function encodeManifestPayload(manifest: P2PFileManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

export type ManifestDecodeResult =
  | { ok: true; manifest: P2PFileManifest }
  | { ok: false; reason: "bad_json" | "bad_shape" | "oversized" };

/** Strict manifest decoder. Mirrors the planner's invariants. */
export function decodeManifestPayload(payload: Uint8Array): ManifestDecodeResult {
  if (payload.byteLength > 16 * 1024) return { ok: false, reason: "oversized" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (parsed === null || typeof parsed !== "object") return { ok: false, reason: "bad_shape" };
  const m = parsed as Record<string, unknown>;
  if (m.v !== 1) return { ok: false, reason: "bad_shape" };
  if (typeof m.transferId !== "string" || !TRANSFER_ID_RE.test(m.transferId)) {
    return { ok: false, reason: "bad_shape" };
  }
  if (typeof m.relPath !== "string" || m.relPath.length === 0) return { ok: false, reason: "bad_shape" };
  if (typeof m.totalChunks !== "number" || !Number.isInteger(m.totalChunks) || m.totalChunks < 1) {
    return { ok: false, reason: "bad_shape" };
  }
  if (typeof m.totalBytes !== "number" || !Number.isInteger(m.totalBytes) || m.totalBytes < 0) {
    return { ok: false, reason: "bad_shape" };
  }
  if (m.totalBytes > P2P_MAX_TRANSFER_BYTES) return { ok: false, reason: "bad_shape" };
  if (typeof m.hash !== "string" || !/^[0-9a-f]{64}$/.test(m.hash)) return { ok: false, reason: "bad_shape" };
  if (typeof m.chunkSize !== "number" || !Number.isInteger(m.chunkSize) || m.chunkSize <= 0) {
    return { ok: false, reason: "bad_shape" };
  }
  return { ok: true, manifest: parsed as P2PFileManifest };
}

/**
 * Encode one chunk payload: 4-byte chunkIndex (u32 BE) + 4-byte payload length
 * (u32 BE) + raw chunk bytes. Header avoids ambiguity on zero-length last
 * chunks and lets the receiver dispatch quickly without JSON parsing on the
 * hot path.
 */
export function encodeFileChunkPayload(chunkIndex: number, chunk: Uint8Array): Uint8Array {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffffffff) {
    throw new Error("p2pFileTransfer: chunkIndex out of u32 range");
  }
  const out = new Uint8Array(P2P_FILE_CHUNK_HEADER_BYTES + chunk.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, chunkIndex, false);
  view.setUint32(4, chunk.byteLength, false);
  out.set(chunk, P2P_FILE_CHUNK_HEADER_BYTES);
  return out;
}

export type ChunkDecodeResult =
  | { ok: true; chunkIndex: number; chunk: Uint8Array }
  | { ok: false; reason: "header_short" | "length_mismatch" };

export function decodeFileChunkPayload(payload: Uint8Array): ChunkDecodeResult {
  if (payload.byteLength < P2P_FILE_CHUNK_HEADER_BYTES) return { ok: false, reason: "header_short" };
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const chunkIndex = view.getUint32(0, false);
  const declaredLen = view.getUint32(4, false);
  if (payload.byteLength - P2P_FILE_CHUNK_HEADER_BYTES !== declaredLen) {
    return { ok: false, reason: "length_mismatch" };
  }
  return { ok: true, chunkIndex, chunk: payload.subarray(P2P_FILE_CHUNK_HEADER_BYTES) };
}

export interface ChunkAssembler {
  applyChunk(chunkIndex: number, chunk: Uint8Array): { ok: true } | { ok: false; reason: string };
  isComplete(): boolean;
  /** When `isComplete()` returns true, builds and validates the file. */
  finalize(): { ok: true; content: Uint8Array; hashOk: boolean } | { ok: false; reason: string };
}

/** Stateful receiver that collects chunks for one transferId and rebuilds the
 * file in-order. Idempotent on duplicate chunkIndex (overwrites; last write
 * wins so a re-send fixes a corrupted chunk). Out-of-order delivery is
 * supported by indexing into `received[]`. */
export function createChunkAssembler(manifest: P2PFileManifest): ChunkAssembler {
  const received: (Uint8Array | undefined)[] = new Array<Uint8Array | undefined>(manifest.totalChunks);
  let receivedCount = 0;

  return {
    applyChunk(chunkIndex, chunk): { ok: true } | { ok: false; reason: string } {
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.totalChunks) {
        return { ok: false, reason: "chunk_index_out_of_range" };
      }
      if (chunk.byteLength > manifest.chunkSize) {
        return { ok: false, reason: "chunk_too_large" };
      }
      if (received[chunkIndex] === undefined) receivedCount += 1;
      received[chunkIndex] = chunk;
      return { ok: true };
    },
    isComplete(): boolean {
      return receivedCount === manifest.totalChunks;
    },
    finalize(): { ok: true; content: Uint8Array; hashOk: boolean } | { ok: false; reason: string } {
      if (receivedCount !== manifest.totalChunks) return { ok: false, reason: "incomplete" };
      let total = 0;
      for (const c of received) {
        if (c === undefined) return { ok: false, reason: "missing_chunk" };
        total += c.byteLength;
      }
      if (total !== manifest.totalBytes) return { ok: false, reason: "byte_mismatch" };
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of received) {
        if (c === undefined) return { ok: false, reason: "missing_chunk" };
        out.set(c, off);
        off += c.byteLength;
      }
      const sha = createSha256Provider();
      const recomputed = sha.hash(out);
      return { ok: true, content: out, hashOk: recomputed === manifest.hash };
    },
  };
}
