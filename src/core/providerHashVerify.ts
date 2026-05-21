/**
 * v0.12 F-043 — pure provider-side hash verifier.
 *
 * After upload, each provider exposes a per-blob digest in its own format:
 *   - GDrive    → `md5Checksum` (MD5 of file bytes)
 *   - Yandex    → `md5` (MD5 of file bytes)
 *   - Dropbox   → `content_hash` (Dropbox "content hash" — chained SHA-256 of 4 MB blocks)
 *   - OneDrive  → `quickXorHash` (proprietary) / `sha1Hash` / `sha256Hash` (sometimes)
 *
 * Our canonical hash (`MetaEntry.hash`) is SHA-256 of plaintext. So we
 * can't compare 1:1 with provider-side digests for most providers. What
 * we CAN do:
 *   - GDrive / Yandex MD5: compute MD5 of plaintext locally and compare.
 *   - Dropbox content_hash: compute Dropbox's algorithm locally and compare.
 *   - OneDrive sha256Hash (when present): direct match.
 *
 * This module produces the **expected provider digest** for the buffer we
 * just uploaded, given the provider type. Caller compares to whatever the
 * provider's metadata API returned.
 *
 * No `vscode` import. Caller may run async if it needs WASM-backed crypto
 * — we use Node's `crypto` for MD5/SHA-1/SHA-256 (safe to use for
 * integrity, not for cryptographic security).
 */

import { createHash } from "node:crypto";
import type { ProviderType } from "./types.js";

export type VerifiableDigestKind = "md5" | "sha1" | "sha256" | "dropbox-content-hash";

export interface ExpectedDigest {
  /** Lowercase hex. */
  value: string;
  /** Hash algorithm used. */
  kind: VerifiableDigestKind;
}

/** MD5 — used by GDrive `md5Checksum` and Yandex `md5`. */
export function md5Hex(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}

/** SHA-1 — used by OneDrive `sha1Hash` (some accounts). */
export function sha1Hex(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

/** SHA-256 — used by OneDrive `sha256Hash` (rare). */
export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Dropbox "content hash" — defined as: split into 4 MiB chunks, hash each
 * chunk with SHA-256, concatenate all chunk hashes, hash the result with
 * SHA-256. Returns lowercase hex.
 * https://developer.dropbox.com/docs/content-hash
 */
export function dropboxContentHash(buffer: Buffer): string {
  const BLOCK = 4 * 1024 * 1024;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += BLOCK) {
    const slice = buffer.subarray(offset, Math.min(offset + BLOCK, buffer.length));
    chunks.push(createHash("sha256").update(slice).digest());
  }
  if (chunks.length === 0) {
    // Empty file: hash of empty bytes once.
    return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  }
  const concatenated = Buffer.concat(chunks);
  return createHash("sha256").update(concatenated).digest("hex");
}

/**
 * Compute the expected provider-side digest for a buffer we just uploaded.
 * Caller compares this to whatever the provider's metadata API returned.
 *
 * When `provider` is OneDrive and we don't know which hash will be present,
 * we precompute all three (md5/sha1/sha256); caller picks whichever the
 * metadata API actually surfaces.
 */
export function expectedProviderDigests(
  provider: ProviderType,
  buffer: Buffer,
): ExpectedDigest[] {
  switch (provider) {
    case "gdrive":
    case "yandex":
      return [{ kind: "md5", value: md5Hex(buffer) }];
    case "dropbox":
      return [{ kind: "dropbox-content-hash", value: dropboxContentHash(buffer) }];
    case "onedrive":
      return [
        { kind: "md5", value: md5Hex(buffer) },
        { kind: "sha1", value: sha1Hex(buffer) },
        { kind: "sha256", value: sha256Hex(buffer) },
      ];
  }
}

/** Constant-time equality for two lowercase hex strings (defensive). */
export function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  }
  return diff === 0;
}
