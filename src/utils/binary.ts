import * as path from "node:path";

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wasm",
  ".parquet",
]);

export function isProbablyBinaryPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Эвристика: NUL в первых байтах → бинарный. */
export function bufferLooksBinary(buf: Buffer, sample = 8000): boolean {
  const n = Math.min(buf.length, sample);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}
