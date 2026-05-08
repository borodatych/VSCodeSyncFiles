/**
 * v2.2.4 — pure helpers for one-time passkey recovery codes.
 *
 *   - `generateRecoveryCodes(n, seed?)` — produces N human-readable codes.
 *   - `hashRecoveryCode(code)` — SHA-256 hex; only the hash is persisted.
 *   - `verifyRecoveryCode(code, hashes)` — constant-time match against the
 *     stored set; returns the matched index or null. Caller marks the index
 *     as consumed (one-time-use) before returning.
 *
 * The codes are formatted as five 4-character groups separated by dashes
 * (`xxxx-xxxx-xxxx-xxxx-xxxx`) using the alphabet [a-z0-9] minus visually
 * ambiguous characters (0/o, 1/i/l). 20 chars × log2(28) ≈ 96 bits of
 * entropy — overkill for a one-time recovery code, but cheap.
 *
 * No `vscode` import.
 */
import { randomBytes, createHash } from "node:crypto";

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789".split("");
const RECOVERY_GROUPS = 5;
const RECOVERY_GROUP_LEN = 4;
const RECOVERY_TOTAL_CHARS = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;

export const DEFAULT_RECOVERY_CODE_COUNT = 5;

export interface GeneratedRecoveryCodes {
  /** Plain-text codes shown to user once. */
  codes: string[];
  /** Hashes to store. Same order as `codes`. */
  hashes: string[];
}

export function generateRecoveryCodes(count: number = DEFAULT_RECOVERY_CODE_COUNT): GeneratedRecoveryCodes {
  if (count < 1 || count > 50) throw new Error("recoveryCodes: count must be 1..50");
  const codes: string[] = [];
  const hashes: string[] = [];
  const alphabetLen = RECOVERY_ALPHABET.length;
  for (let i = 0; i < count; i++) {
    const buf = randomBytes(RECOVERY_TOTAL_CHARS);
    let raw = "";
    for (let j = 0; j < RECOVERY_TOTAL_CHARS; j++) {
      raw += RECOVERY_ALPHABET[buf[j] % alphabetLen];
    }
    const code: string[] = [];
    for (let g = 0; g < RECOVERY_GROUPS; g++) {
      code.push(raw.slice(g * RECOVERY_GROUP_LEN, (g + 1) * RECOVERY_GROUP_LEN));
    }
    const formatted = code.join("-");
    codes.push(formatted);
    hashes.push(hashRecoveryCode(formatted));
  }
  return { codes, hashes };
}

/** Normalised + hashed recovery code (lowercase + dashes stripped, then sha256). */
export function hashRecoveryCode(code: string): string {
  const normalised = normaliseRecoveryCode(code);
  return createHash("sha256").update(normalised).digest("hex");
}

function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, "");
}

/** Constant-time compare against the stored hashes. Returns the matched
 * index or null. Caller marks the index consumed (set hashes[i] = ""). */
export function verifyRecoveryCode(code: string, storedHashes: string[]): number | null {
  const probe = hashRecoveryCode(code);
  let foundIndex: number | null = null;
  for (let i = 0; i < storedHashes.length; i++) {
    const stored = storedHashes[i];
    if (stored.length === 0) continue; // already consumed
    if (constantTimeEqualHex(probe, stored)) {
      // Continue scanning so timing remains constant w.r.t. stored.length.
      foundIndex ??= i;
    }
  }
  return foundIndex;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}
