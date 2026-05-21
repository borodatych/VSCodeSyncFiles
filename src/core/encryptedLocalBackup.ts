/**
 * v0.16 N06 — encrypt-at-rest wrapper for local backup files.
 *
 * The existing `.vscode/vscodesync-local-backup/` directory stores
 * plaintext copies of every pulled file. If the laptop is stolen, that's
 * a leak. This module wraps backup bytes with the same AES-256-GCM
 * envelope as cloud uploads when `vscodesync.localBackup.encryptAtRest`
 * is on AND the user has set up an encryption key.
 *
 * File extension `.enc` is appended; readers strip it.
 */

import { encryptBuffer, decryptBuffer } from "./encryption.js";

export interface EncryptedBackupOptions {
  /** When true, wrap. When false, return buffer unchanged. */
  encryptAtRest: boolean;
  /** AES-256 key (32 bytes). Required when encryptAtRest=true. */
  key?: Buffer | null;
}

export interface EncryptedBackupWrite {
  /** Bytes to write. */
  bytes: Buffer;
  /** Suffix to append to the filename (".enc" when encrypted, "" otherwise). */
  filenameSuffix: string;
}

/** Encode for write. Pure. */
export function encodeBackupForWrite(
  plaintext: Buffer,
  opts: EncryptedBackupOptions,
): EncryptedBackupWrite {
  if (!opts.encryptAtRest || !opts.key) {
    return { bytes: plaintext, filenameSuffix: "" };
  }
  const wrapped = encryptBuffer(opts.key, plaintext);
  return { bytes: wrapped, filenameSuffix: ".enc" };
}

export class EncryptedBackupKeyMissingError extends Error {
  constructor(message = "Encrypted backup file requires a key, but none was provided.") {
    super(message);
    this.name = "EncryptedBackupKeyMissingError";
  }
}

/**
 * Decode after read.
 *
 * v0.17 A7 fix — when the filename ends with `.enc` but no key is
 * supplied, throw `EncryptedBackupKeyMissingError` rather than silently
 * returning ciphertext bytes as "plaintext". Callers must handle the
 * missing-key path explicitly (prompt the user, or skip the backup).
 */
export function decodeBackupAfterRead(
  bytes: Buffer,
  filename: string,
  opts: EncryptedBackupOptions,
): { plaintext: Buffer; wasEncrypted: boolean } {
  if (filename.endsWith(".enc")) {
    if (!opts.key) {
      throw new EncryptedBackupKeyMissingError();
    }
    return { plaintext: decryptBuffer(opts.key, bytes), wasEncrypted: true };
  }
  return { plaintext: bytes, wasEncrypted: false };
}
