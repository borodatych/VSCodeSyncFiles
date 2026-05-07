/**
 * Direct unit-tests for src/core/encryption.ts. The platformCrypto layer
 * exercises the higher-level ICrypto contract; these tests pin down the
 * AES-256-GCM wire format + PBKDF2 password-protected export/import flow
 * that p2pCryptoEnvelope and the encryption-key commands depend on.
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptBuffer,
  encryptBuffer,
  exportKeyWithPassword,
  generateEncryptionKey,
  importKeyWithPassword,
} from "../../src/core/encryption.js";

const KEY = randomBytes(32);

describe("encryptBuffer / decryptBuffer", () => {
  it("round-trips arbitrary plaintext", () => {
    const plain = Buffer.from("hello, world — VSCodeSync 🔒");
    const blob = encryptBuffer(KEY, plain);
    const back = decryptBuffer(KEY, blob);
    expect(back.toString("utf8")).toBe(plain.toString("utf8"));
  });

  it("round-trips empty plaintext", () => {
    const blob = encryptBuffer(KEY, Buffer.alloc(0));
    const back = decryptBuffer(KEY, blob);
    expect(back.length).toBe(0);
  });

  it("round-trips large plaintext (~64 KiB)", () => {
    const plain = randomBytes(64 * 1024);
    const blob = encryptBuffer(KEY, plain);
    const back = decryptBuffer(KEY, blob);
    expect(back.equals(plain)).toBe(true);
  });

  it("uses a fresh IV each call (ciphertext differs for identical inputs)", () => {
    const plain = Buffer.from("identical");
    const a = encryptBuffer(KEY, plain);
    const b = encryptBuffer(KEY, plain);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects decrypt with a different key (authTag mismatch)", () => {
    const plain = Buffer.from("secret");
    const blob = encryptBuffer(KEY, plain);
    const wrong = randomBytes(32);
    expect(() => decryptBuffer(wrong, blob)).toThrow();
  });

  it("rejects decrypt of tampered ciphertext (last byte flip)", () => {
    const blob = encryptBuffer(KEY, Buffer.from("secret"));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptBuffer(KEY, tampered)).toThrow();
  });

  it("rejects blobs shorter than IV + authTag (12 + 16 = 28 bytes)", () => {
    expect(() => decryptBuffer(KEY, Buffer.alloc(10))).toThrow(/недостаточно данных|wrong/i);
  });
});

describe("generateEncryptionKey", () => {
  it("returns a 32-byte buffer", () => {
    const k = generateEncryptionKey();
    expect(k.length).toBe(32);
  });

  it("returns distinct keys across calls (entropy check)", () => {
    const a = generateEncryptionKey();
    const b = generateEncryptionKey();
    expect(a.equals(b)).toBe(false);
  });
});

describe("exportKeyWithPassword / importKeyWithPassword", () => {
  it("round-trips a generated key through a password", async () => {
    const key = generateEncryptionKey();
    const blob = await exportKeyWithPassword(key, "correct horse battery staple");
    const back = await importKeyWithPassword(blob, "correct horse battery staple");
    expect(back.equals(key)).toBe(true);
  });

  it("rejects import with the wrong password", async () => {
    const key = generateEncryptionKey();
    const blob = await exportKeyWithPassword(key, "right");
    await expect(importKeyWithPassword(blob, "wrong")).rejects.toThrow();
  });

  it("rejects import of a too-short blob", async () => {
    await expect(importKeyWithPassword(Buffer.alloc(40), "x")).rejects.toThrow();
  });

  it("uses a fresh salt each export (same key + same password → different blob)", async () => {
    const key = generateEncryptionKey();
    const a = await exportKeyWithPassword(key, "p");
    const b = await exportKeyWithPassword(key, "p");
    expect(a.equals(b)).toBe(false);
  });
});
