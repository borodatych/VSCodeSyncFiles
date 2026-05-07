/**
 * Platform-agnostic compression interface with desktop (node:zlib) and web (CompressionStream) implementations.
 * Compatible with wireCompression.ts gzip format (raw gzip stream, same as zlib.gzipSync).
 *
 * v2.3 (skeleton): optional zstd round-trip via @bokuweb/zstd-wasm. The
 * methods are optional — callers branch on `wireZstd` flag in `_meta` and fall
 * back to gzip when zstd isn't compiled into the build.
 */

export interface ICompression {
  /**
   * Gzip compress. Returns compressed bytes if they are meaningfully smaller than input,
   * otherwise returns undefined (to avoid uploading larger blobs).
   */
  gzip(data: Uint8Array): Promise<Uint8Array | undefined>;
  /** Gzip decompress. */
  gunzip(data: Uint8Array): Promise<Uint8Array>;
  /** Zstd compress. Optional — returns undefined when zstd backend is unavailable. */
  zstd?(data: Uint8Array): Promise<Uint8Array | undefined>;
  /** Zstd decompress. Optional. */
  unzstd?(data: Uint8Array): Promise<Uint8Array>;
  /** True when the implementation actually has zstd wired up. */
  zstdAvailable?(): boolean;
}

const GZIP_SAVINGS_THRESHOLD = 24; // bytes — matches wireCompression.ts
const ZSTD_SAVINGS_THRESHOLD = 24;

// ─── Desktop implementation (node:zlib) ──────────────────────────────────────

export function createNodeCompression(): ICompression {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require("node:zlib") as typeof import("node:zlib");

  return {
    gzip(data: Uint8Array): Promise<Uint8Array | undefined> {
      const gz = zlib.gzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (gz.length + GZIP_SAVINGS_THRESHOLD >= data.length) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(gz);
    },

    gunzip(data: Uint8Array): Promise<Uint8Array> {
      return Promise.resolve(zlib.gunzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    },

    ...zstdAddon(),
  };
}

/**
 * Optional zstd add-on backed by @bokuweb/zstd-wasm. Loaded lazily so users
 * who don't enable `wireZstd` never pay the WASM init cost. If the dep is
 * missing (not installed in the bundle), `zstdAvailable()` returns false and
 * the wire-codec layer falls back to gzip.
 */
function zstdAddon(): Pick<ICompression, "zstd" | "unzstd" | "zstdAvailable"> {
  let inited: Promise<typeof import("@bokuweb/zstd-wasm") | null> | null = null;
  const load = (): Promise<typeof import("@bokuweb/zstd-wasm") | null> => {
    if (inited) return inited;
    inited = (async () => {
      try {
        // Dynamic import — keeps zstd-wasm out of the web bundle and lets
        // installs without the optional dep boot cleanly.
        const mod = (await import("@bokuweb/zstd-wasm")) as typeof import("@bokuweb/zstd-wasm");
        await mod.init();
        return mod;
      } catch {
        return null;
      }
    })();
    return inited;
  };

  return {
    zstdAvailable(): boolean {
      // Synchronous probe by checking if init has resolved with a module.
      // Callers expecting a fast path should `await zstd(...)` instead.
      return inited !== null;
    },
    async zstd(data: Uint8Array): Promise<Uint8Array | undefined> {
      const mod = await load();
      if (!mod) return undefined;
      const out = mod.compress(data, 3);
      if (out.length + ZSTD_SAVINGS_THRESHOLD >= data.length) return undefined;
      return out;
    },
    async unzstd(data: Uint8Array): Promise<Uint8Array> {
      const mod = await load();
      if (!mod) throw new Error("zstd backend not available");
      return mod.decompress(data);
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
      const gz = await collectStream(cs.readable);
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
      return collectStream(ds.readable);
    },
  };
}
