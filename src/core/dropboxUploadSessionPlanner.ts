/**
 * v0.12 F-040 — pure planner for Dropbox upload session chunking.
 *
 * Dropbox `/files/upload` accepts at most ~150 MB per single shot. Larger
 * files need `/files/upload_session/{start,append_v2,finish}`. This module
 * decides:
 *   - whether a session is needed (size > threshold)
 *   - chunk sizes (uniform PAGE_BYTES; last chunk may be short)
 *   - offsets per chunk (for `append_v2` calls)
 *   - whether each call is a `start` / `append` / `finish`
 *
 * Caller wires the actual HTTP calls; planner is unit-testable.
 */

export interface DropboxUploadChunk {
  /** 0-based offset into the source buffer. */
  offset: number;
  /** Number of bytes from offset. */
  length: number;
  /** What Dropbox endpoint this chunk targets. */
  endpoint: "start" | "append_v2" | "finish";
}

export interface DropboxUploadPlan {
  /** True when single-shot `/files/upload` is enough. */
  singleShot: boolean;
  /** Ordered chunks for session upload (empty when singleShot). */
  chunks: DropboxUploadChunk[];
  /** Total bytes. */
  totalBytes: number;
}

export interface DropboxUploadPlanOptions {
  /** Threshold above which session upload is used. Default 150 MB. */
  sessionThresholdBytes?: number;
  /** Chunk size for append_v2 calls. Default 8 MB. */
  chunkBytes?: number;
}

const MB = 1024 * 1024;
const DEFAULT_THRESHOLD = 150 * MB;
const DEFAULT_CHUNK = 8 * MB;
const MAX_CHUNK = 60 * MB;

export function planDropboxUpload(
  byteLength: number,
  opts: DropboxUploadPlanOptions = {},
): DropboxUploadPlan {
  const threshold = Math.max(1024, opts.sessionThresholdBytes ?? DEFAULT_THRESHOLD);
  const chunk = Math.max(1024, Math.min(MAX_CHUNK, opts.chunkBytes ?? DEFAULT_CHUNK));

  if (byteLength <= threshold) {
    return { singleShot: true, chunks: [], totalBytes: byteLength };
  }

  const chunks: DropboxUploadChunk[] = [];
  let offset = 0;
  while (offset < byteLength) {
    const length = Math.min(chunk, byteLength - offset);
    let endpoint: DropboxUploadChunk["endpoint"];
    if (offset === 0) endpoint = "start";
    else if (offset + length >= byteLength) endpoint = "finish";
    else endpoint = "append_v2";
    chunks.push({ offset, length, endpoint });
    offset += length;
  }
  // For very small "over threshold" inputs we might collapse into start
  // (single chunk that's both the start AND the finish). Dropbox API
  // doesn't support that; in that case fall back to single-shot.
  if (chunks.length === 1) {
    return { singleShot: true, chunks: [], totalBytes: byteLength };
  }
  return { singleShot: false, chunks, totalBytes: byteLength };
}
