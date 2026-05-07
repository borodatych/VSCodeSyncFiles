/**
 * @experimental v2.3 — pure wire-codec helpers, called only by tests today.
 * Wired into the engine when zstd / blake3 ship. Do NOT delete.
 *
 * Wire-codec helpers — abstract over the «which compression on the wire» flags
 * stored in `_meta.files[].wireGzip` / `wireZstd` (v2.3, planned WASM zstd).
 *
 * Pure: no provider, no fs, no vscode. Lets the engine pick a codec at upload
 * time and detect it at download time without if-else everywhere.
 *
 * Decode helpers throw on unknown codecs — readers must handle the error and
 * either ask the user to update the extension or fall back to "treat the
 * blob as raw" (preserves backward compat when an older client wrote the
 * blob with a future codec).
 */

export type WireCodec = "raw" | "gzip" | "zstd";

export interface CodecFlags {
  wireGzip?: boolean;
  wireZstd?: boolean;
}

/** Pick which codec the writer used, based on the meta-entry flags. */
export function detectWireCodec(flags: CodecFlags): WireCodec {
  if (flags.wireGzip && flags.wireZstd) {
    throw new Error("wire codec: both gzip and zstd flags set — invalid meta entry");
  }
  if (flags.wireGzip) return "gzip";
  if (flags.wireZstd) return "zstd";
  return "raw";
}

/** Build the meta-flag pair for a chosen codec. Always sets exactly one flag. */
export function flagsForCodec(codec: WireCodec): CodecFlags {
  switch (codec) {
    case "gzip":
      return { wireGzip: true };
    case "zstd":
      return { wireZstd: true };
    case "raw":
      return {};
  }
}

/**
 * Pure decision: which codec to use for a buffer of `byteLength` bytes,
 * given the configured `compressUploads` toggle and whether a zstd backend
 * is currently available.
 *
 * - `compressUploads = false` → always raw
 * - small payloads (< 1 KiB) skip compression — overhead exceeds savings
 * - prefer zstd when both are available (better ratio on text)
 */
export function chooseWireCodec(
  byteLength: number,
  opts: { compressUploads: boolean; zstdAvailable: boolean },
): WireCodec {
  if (!opts.compressUploads) return "raw";
  if (byteLength < 1024) return "raw";
  return opts.zstdAvailable ? "zstd" : "gzip";
}

/** Human-readable label for log output / status bar. */
export function describeCodec(codec: WireCodec): string {
  switch (codec) {
    case "gzip":
      return "gzip";
    case "zstd":
      return "zstd";
    case "raw":
      return "raw";
  }
}

/** Codecs the production read-path can actually decompress. */
export const SUPPORTED_WIRE_CODECS: readonly WireCodec[] = ["raw", "gzip"];

/**
 * Throw on a meta entry tagged with a codec this build can't decompress.
 *
 * Today that means **`wireZstd: true` is rejected** — the v2.3 zstd
 * read-path isn't wired into the engine yet, so silently accepting a zstd
 * blob would yield gibberish on download. Future builds bump
 * `SUPPORTED_WIRE_CODECS` once the engine gains a `unzstd` branch.
 */
export function assertSupportedCodec(
  flags: CodecFlags,
  supported: readonly WireCodec[] = SUPPORTED_WIRE_CODECS,
): void {
  const codec = detectWireCodec(flags);
  if (!supported.includes(codec)) {
    throw new Error(
      `wire codec "${codec}" not supported in this build (supported: ${supported.join(", ")})`,
    );
  }
}
