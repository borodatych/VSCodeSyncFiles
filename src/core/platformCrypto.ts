/**
 * Platform-agnostic crypto interface with desktop (node:crypto) and web (SubtleCrypto) implementations.
 * Wire format compatibility is preserved: IV(12) || ciphertext || authTag(16) for AES-256-GCM.
 */

export interface ICrypto {
  /** Generate a random 32-byte AES-256 key. */
  generateKey(): Promise<Uint8Array>;
  /** AES-256-GCM encrypt. Returns IV(12) || ciphertext || authTag(16). */
  encrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  /** AES-256-GCM decrypt. Input: IV(12) || ciphertext || authTag(16). */
  decrypt(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array>;
  /** SHA-256 digest. */
  sha256(data: Uint8Array): Promise<Uint8Array>;
  /** Cryptographically-random bytes. */
  randomBytes(n: number): Uint8Array;
}

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

// ─── Desktop implementation (node:crypto) ────────────────────────────────────

/**
 * Node.js implementation using node:crypto (synchronous, zero-dependency).
 * Loaded only in the desktop extension entrypoint.
 */
export function createNodeCrypto(): ICrypto {
  // Dynamic require to avoid bundling node: modules in web bundle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");

  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async generateKey(): Promise<Uint8Array> {
      return nodeCrypto.randomBytes(KEY_BYTES);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async encrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
      const iv = nodeCrypto.randomBytes(IV_BYTES);
      const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key);
      const cipher = nodeCrypto.createCipheriv("aes-256-gcm", keyBuf, iv);
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return Buffer.concat([iv, ciphertext, authTag]);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async decrypt(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
      if (blob.length < IV_BYTES + AUTH_TAG_BYTES) {
        throw new Error("ICrypto(node): blob too short");
      }
      const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key);
      const blobBuf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
      const iv = blobBuf.subarray(0, IV_BYTES);
      const authTag = blobBuf.subarray(blobBuf.length - AUTH_TAG_BYTES);
      const ciphertext = blobBuf.subarray(IV_BYTES, blobBuf.length - AUTH_TAG_BYTES);
      const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", keyBuf, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async sha256(data: Uint8Array): Promise<Uint8Array> {
      return nodeCrypto.createHash("sha256").update(data).digest();
    },

    randomBytes(n: number): Uint8Array {
      return nodeCrypto.randomBytes(n);
    },
  };
}

// ─── Web implementation (SubtleCrypto) ───────────────────────────────────────

/**
 * Browser / VS Code web extension implementation using SubtleCrypto (async, no Node APIs).
 * SubtleCrypto AES-GCM uses 128-bit auth tag by default (matches node:crypto's 16-byte authTag).
 */
export function createWebCrypto(): ICrypto {
  const subtle = crypto.subtle;

  // SubtleCrypto types declare `BufferSource` (= ArrayBuffer | ArrayBufferView<ArrayBuffer>).
  // TS sees our `Uint8Array<ArrayBufferLike>` (which includes SharedArrayBuffer) as a
  // wider type. We only ever produce regular ArrayBuffers — the cast is safe.
  const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

  async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
    return subtle.importKey("raw", bs(key), { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  return {
    async generateKey(): Promise<Uint8Array> {
      const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ]);
      const exported = await subtle.exportKey("raw", key);
      return new Uint8Array(exported);
    },

    async encrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const cryptoKey: CryptoKey = await importAesKey(key);
      // SubtleCrypto AES-GCM appends authTag to the end of ciphertext output
      const encrypted = await subtle.encrypt(
        { name: "AES-GCM", iv: bs(iv), tagLength: AUTH_TAG_BYTES * 8 },
        cryptoKey,
        bs(plaintext),
      );
      // encrypted = ciphertext || authTag (WebCrypto convention)
      const result = new Uint8Array(IV_BYTES + encrypted.byteLength);
      result.set(iv, 0);
      result.set(new Uint8Array(encrypted), IV_BYTES);
      return result;
    },

    async decrypt(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
      if (blob.length < IV_BYTES + AUTH_TAG_BYTES) {
        throw new Error("ICrypto(web): blob too short");
      }
      const iv = blob.subarray(0, IV_BYTES);
      // WebCrypto expects ciphertext || authTag in one buffer (same layout as after IV)
      const ciphertextWithTag = blob.subarray(IV_BYTES);
      const cryptoKey: CryptoKey = await importAesKey(key);
      const decrypted = await subtle.decrypt(
        { name: "AES-GCM", iv: bs(iv), tagLength: AUTH_TAG_BYTES * 8 },
        cryptoKey,
        bs(ciphertextWithTag),
      );
      return new Uint8Array(decrypted);
    },

    async sha256(data: Uint8Array): Promise<Uint8Array> {
      const digest = await subtle.digest("SHA-256", bs(data));
      return new Uint8Array(digest);
    },

    randomBytes(n: number): Uint8Array {
      return crypto.getRandomValues(new Uint8Array(n));
    },
  };
}
