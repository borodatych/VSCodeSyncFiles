/**
 * Platform-agnostic compression interface with desktop (node:zlib) and web (CompressionStream) implementations.
 * Compatible with wireCompression.ts gzip format (raw gzip stream, same as zlib.gzipSync).
 */

export interface ICompression {
  /**
   * Gzip compress. Returns compressed bytes if they are meaningfully smaller than input,
   * otherwise returns undefined (to avoid uploading larger blobs).
   */
  gzip(data: Uint8Array): Promise<Uint8Array | undefined>;
  /** Gzip decompress. */
  gunzip(data: Uint8Array): Promise<Uint8Array>;
}

const GZIP_SAVINGS_THRESHOLD = 24; // bytes — matches wireCompression.ts

// ─── Desktop implementation (node:zlib) ──────────────────────────────────────

export function createNodeCompression(): ICompression {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require("node:zlib") as typeof import("node:zlib");

  return {
    async gzip(data: Uint8Array): Promise<Uint8Array | undefined> {
      const gz = zlib.gzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (gz.length + GZIP_SAVINGS_THRESHOLD >= data.length) {
        return undefined;
      }
      return gz;
    },

    async gunzip(data: Uint8Array): Promise<Uint8Array> {
      return zlib.gunzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
  };
}

// ─── Web implementation (CompressionStream) ───────────────────────────────────

/** Collect a ReadableStream<Uint8Array> into a single Uint8Array. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function createWebCompression(): ICompression {
  return {
    async gzip(data: Uint8Array): Promise<Uint8Array | undefined> {
      const cs = new CompressionStream("gzip");
      const writer = cs.writable.getWriter();
      await writer.write(data);
      await writer.close();
      const gz = await collectStream(cs.readable as ReadableStream<Uint8Array>);
      if (gz.length + GZIP_SAVINGS_THRESHOLD >= data.length) {
        return undefined;
      }
      return gz;
    },

    async gunzip(data: Uint8Array): Promise<Uint8Array> {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      await writer.write(data);
      await writer.close();
      return collectStream(ds.readable as ReadableStream<Uint8Array>);
    },
  };
}
