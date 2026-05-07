/**
 * @experimental v2.3 BLAKE3-ready hash abstraction. Wired in v2.x — keep
 * until `vscodesync.canonicalHashAlgo` setting + migration plan ship.
 * Production hashing still goes through `utils/hash.ts`. Do NOT delete.
 *
 * Hash-provider abstraction. v1 of VSCodeSync hard-codes SHA-256; this module
 * paves the way to switch tracked files to BLAKE3 when the WASM (or pure-JS)
 * backend is available — without rewriting every hash call site.
 *
 * Two backends:
 *   - `sha256` — node:crypto (desktop) or SubtleCrypto (web). Always available.
 *   - `blake3` — `@noble/hashes/blake3`, pure JS, no native deps. Optional.
 *
 * Keeping this vscode-free + sync (Uint8Array → Uint8Array) so it can be
 * unit-tested directly. The `computeHash` pipeline in `utils/hash.ts` uses
 * its own SHA-256 path today; this module is the staging ground for a future
 * `vscodesync.canonicalHashAlgo` setting.
 */
import { createHash } from "node:crypto";

export type HashAlgo = "sha256" | "blake3";

export interface HashProvider {
  readonly algo: HashAlgo;
  /** Synchronous one-shot hash. Returns lowercase hex of 32 bytes (256-bit digest). */
  hash(data: Uint8Array): string;
}

/** SHA-256 via node:crypto. Always present in the desktop bundle. */
export function createSha256Provider(): HashProvider {
  return {
    algo: "sha256",
    hash(data: Uint8Array): string {
      return createHash("sha256").update(data).digest("hex");
    },
  };
}

/**
 * BLAKE3 via @noble/hashes (pure JS, ~30 KB minified). Returns null when the
 * dep is not installed in this build — caller falls back to SHA-256.
 *
 * Loads lazily via require() so a fresh install without the optional dep
 * still boots cleanly.
 */
export function createBlake3ProviderSync(): HashProvider | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@noble/hashes/blake3") as {
      blake3: (msg: Uint8Array, opts?: { dkLen?: number }) => Uint8Array;
    };
    return {
      algo: "blake3",
      hash(data: Uint8Array): string {
        const digest = mod.blake3(data, { dkLen: 32 });
        return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
      },
    };
  } catch {
    return null;
  }
}

/**
 * Pick a hash provider by name; falls back to SHA-256 when the requested
 * algorithm is unavailable in this build.
 */
export function selectHashProvider(preferred: HashAlgo): HashProvider {
  if (preferred === "blake3") {
    const b3 = createBlake3ProviderSync();
    if (b3) return b3;
  }
  return createSha256Provider();
}

/** Constant-time equality for two hex digests of the same length. */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}
