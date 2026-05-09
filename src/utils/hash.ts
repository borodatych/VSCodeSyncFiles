import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LineEndingMode } from "./normalize.js";
import { normalizeLineEndings } from "./normalize.js";
import { stripSyncignoreBlocks } from "./syncignore.js";
import { bufferLooksBinary, isProbablyBinaryPath } from "./binary.js";
import { computeHashDual, type DualHash } from "../core/hashProviders.js";

export interface HashConfig {
  lineEnding: LineEndingMode;
  /**
   * When true (default), UTF-8 BOM is stripped before hashing and invalid UTF-8 is reported via `onTextEncodingIssue`.
   * Tests may set false to opt out of BOM stripping if needed (normally leave default).
   */
  encodingLint?: boolean;
  onTextEncodingIssue?: (kind: "bom" | "invalid_utf8") => void;
}

/** Порядок операций для канона (документация + тип для будущих фаз). */
export type CanonicalPushStage = "normalize" | "sanitize" | "hash" | "compress" | "encrypt" | "upload";
export type CanonicalPullStage = "download" | "decrypt" | "decompress" | "merge_syncignore" | "write";

export interface CanonicalPipeline {
  push: CanonicalPushStage[];
  pull: CanonicalPullStage[];
}

export const DEFAULT_CANONICAL_PIPELINE: CanonicalPipeline = {
  push: ["normalize", "sanitize", "hash", "compress", "encrypt", "upload"],
  pull: ["download", "decrypt", "decompress", "merge_syncignore", "write"],
};

function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function hashUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Strip UTF-8 BOM bytes only (canonical text pipeline). */
function stripLeadingUtf8Bom(buf: Buffer): { data: Buffer; hadBom: boolean } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { data: buf.subarray(3), hadBom: true };
  }
  return { data: buf, hadBom: false };
}

function utf8StrictValid(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply canonical pipeline (binary detect → BOM strip → UTF-8 line-ending
 * normalisation → syncignore strip) and return the bytes that should be
 * hashed. Both `hashCanonicalBuffer` and `hashCanonicalBufferDual` go through
 * this so SHA-256 and BLAKE3 are guaranteed to digest the exact same input.
 */
function canonicaliseToHashableBytes(
  buf: Buffer,
  posixPath: string,
  config: HashConfig,
): Buffer {
  const extBinary = isProbablyBinaryPath(posixPath);
  const sniffBinary = bufferLooksBinary(buf);
  if (extBinary || sniffBinary) {
    return buf;
  }

  const { data: rawBuf, hadBom } = stripLeadingUtf8Bom(buf);
  const lint = config.encodingLint !== false;
  if (lint && config.onTextEncodingIssue) {
    if (hadBom) {
      config.onTextEncodingIssue("bom");
    }
    if (!utf8StrictValid(rawBuf)) {
      config.onTextEncodingIssue("invalid_utf8");
    }
  }

  let text = rawBuf.toString("utf8");
  text = normalizeLineEndings(text, config.lineEnding);
  text = stripSyncignoreBlocks(text);
  return Buffer.from(text, "utf8");
}

export function hashCanonicalBuffer(buf: Buffer, posixPath: string, config: HashConfig): string {
  const canonical = canonicaliseToHashableBytes(buf, posixPath, config);
  return canonical === buf ? hashBuffer(buf) : hashUtf8(canonical.toString("utf8"));
}

export function hashCanonicalBufferDual(
  buf: Buffer,
  posixPath: string,
  config: HashConfig,
): DualHash {
  const canonical = canonicaliseToHashableBytes(buf, posixPath, config);
  return computeHashDual(new Uint8Array(canonical));
}

export async function computeHash(filePath: string, config: HashConfig): Promise<string> {
  const buf = await readFile(filePath);
  return hashCanonicalBuffer(buf, filePath, config);
}

export async function computeHashDualCanonical(
  filePath: string,
  config: HashConfig,
): Promise<DualHash> {
  const buf = await readFile(filePath);
  return hashCanonicalBufferDual(buf, filePath, config);
}
