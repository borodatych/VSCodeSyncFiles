/**
 * AES-256-GCM encryption for VSCodeSync files.
 * Wire format on cloud: IV (12 bytes) || CipherText || AuthTag (16 bytes)
 */
import * as crypto from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGO = "aes-256-gcm" as const;

const PBKDF2_ITERS = 200_000;
const PBKDF2_DIGEST = "sha256";
const PBKDF2_SALT_BYTES = 32;
const PBKDF2_KEY_LEN = KEY_BYTES;

export function generateEncryptionKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

export function encryptBuffer(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]);
}

export function decryptBuffer(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("Encryption: недостаточно данных для расшифровки (неверный формат или не зашифровано)");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(blob.length - AUTH_TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES, blob.length - AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Export key encrypted with a user password (PBKDF2 + AES-256-GCM).
 * Wire format: salt (32) || IV (12) || ciphertext || authTag (16)
 */
export async function exportKeyWithPassword(key: Buffer, password: string): Promise<Buffer> {
  const salt = crypto.randomBytes(PBKDF2_SALT_BYTES);
  const derivedKey = await pbkdf2Async(password, salt);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, derivedKey, iv);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, ciphertext, authTag]);
}

/**
 * Import key from encrypted blob (produced by exportKeyWithPassword).
 */
export async function importKeyWithPassword(blob: Buffer, password: string): Promise<Buffer> {
  const minLen = PBKDF2_SALT_BYTES + IV_BYTES + KEY_BYTES + AUTH_TAG_BYTES;
  if (blob.length < minLen) {
    throw new Error("Encryption: неверный формат файла ключа");
  }
  const salt = blob.subarray(0, PBKDF2_SALT_BYTES);
  const iv = blob.subarray(PBKDF2_SALT_BYTES, PBKDF2_SALT_BYTES + IV_BYTES);
  const authTag = blob.subarray(blob.length - AUTH_TAG_BYTES);
  const ciphertext = blob.subarray(PBKDF2_SALT_BYTES + IV_BYTES, blob.length - AUTH_TAG_BYTES);
  const derivedKey = await pbkdf2Async(password, salt);
  const decipher = crypto.createDecipheriv(ALGO, derivedKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function pbkdf2Async(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERS, PBKDF2_KEY_LEN, PBKDF2_DIGEST, (err, dk) => {
      if (err) {
        reject(err);
      } else {
        resolve(dk);
      }
    });
  });
}
