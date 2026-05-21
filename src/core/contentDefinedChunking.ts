/**
 * M1 — Content-defined chunking (CDC) — pure skeleton.
 *
 * Uses a rolling-hash window to find «content-defined» chunk boundaries:
 * a chunk ends when the rolling hash matches a fixed mask (so the same
 * content always produces the same chunk boundaries regardless of file
 * offsets). Allows deduplicating chunks between file versions / files.
 *
 * This module is the **boundary finder only**. Storing / addressing
 * chunks (content hash → blob path), the dedup index, and the
 * reconstruction-on-pull path live in `chunkStore.ts` — TODO.
 *
 * Algorithm: Buzhash-style 32-bit rolling hash with a 64-byte window.
 */

const WINDOW = 64;
const MIN_CHUNK = 16 * 1024;
const MAX_CHUNK = 64 * 1024;
const MASK_TARGET = 0x1fff; // → ~8 KB average chunk size

function rotL(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/**
 * Find chunk boundaries in `buf`. Returns ordered list of exclusive end
 * offsets — chunks are `[0, ends[0])`, `[ends[0], ends[1])`, etc.
 */
export function findChunkBoundaries(buf: Buffer): number[] {
  const ends: number[] = [];
  if (buf.length === 0) return ends;
  let h = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const out = i >= WINDOW ? buf[i - WINDOW] ?? 0 : 0;
    const inb = buf[i] ?? 0;
    h = (rotL(h, 1) ^ rotL(out, WINDOW % 32) ^ inb) >>> 0;
    const cur = ends.length === 0 ? i + 1 : i + 1 - (ends[ends.length - 1] ?? 0);
    if (cur < MIN_CHUNK) continue;
    if (cur >= MAX_CHUNK || (h & MASK_TARGET) === 0) {
      ends.push(i + 1);
    }
  }
  if (ends[ends.length - 1] !== buf.length) ends.push(buf.length);
  return ends;
}

/** Sentinel: thrown by wiring when CDC dedup-store is requested but
 *  storage backend isn't connected yet. */
export class CdcStoreNotConnectedError extends Error {
  constructor() {
    super("CDC: chunk store backend not wired");
    this.name = "CdcStoreNotConnectedError";
  }
}
