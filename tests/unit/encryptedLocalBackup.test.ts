import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decodeBackupAfterRead,
  encodeBackupForWrite,
} from "../../src/core/encryptedLocalBackup.js";

describe("encodeBackupForWrite", () => {
  it("returns plaintext unchanged when encryptAtRest=false", () => {
    const plain = Buffer.from("hello");
    const r = encodeBackupForWrite(plain, { encryptAtRest: false });
    expect(r.bytes).toBe(plain);
    expect(r.filenameSuffix).toBe("");
  });

  it("returns plaintext unchanged when key is missing", () => {
    const plain = Buffer.from("hello");
    const r = encodeBackupForWrite(plain, { encryptAtRest: true, key: null });
    expect(r.bytes).toBe(plain);
    expect(r.filenameSuffix).toBe("");
  });

  it("wraps with .enc suffix when encryptAtRest=true + key", () => {
    const key = randomBytes(32);
    const plain = Buffer.from("secret content");
    const r = encodeBackupForWrite(plain, { encryptAtRest: true, key });
    expect(r.filenameSuffix).toBe(".enc");
    expect(r.bytes.equals(plain)).toBe(false);
  });
});

describe("decodeBackupAfterRead", () => {
  it("returns plaintext unchanged when no .enc suffix", () => {
    const r = decodeBackupAfterRead(Buffer.from("hello"), "x.bak", { encryptAtRest: false });
    expect(r.plaintext.toString()).toBe("hello");
    expect(r.wasEncrypted).toBe(false);
  });

  it("round-trips encrypt → decrypt", () => {
    const key = randomBytes(32);
    const plain = Buffer.from("round trip data");
    const enc = encodeBackupForWrite(plain, { encryptAtRest: true, key });
    const dec = decodeBackupAfterRead(enc.bytes, `x${enc.filenameSuffix}`, { encryptAtRest: true, key });
    expect(dec.wasEncrypted).toBe(true);
    expect(dec.plaintext.toString()).toBe("round trip data");
  });

  it("missing key on encrypted file → throws EncryptedBackupKeyMissingError", () => {
    // v0.17 A7 — returning ciphertext-as-plaintext was a footgun. Now we
    // throw so callers explicitly handle "encrypted backup, no key".
    expect(() =>
      decodeBackupAfterRead(Buffer.from("opaque"), "x.enc", { encryptAtRest: false }),
    ).toThrow(/key/i);
  });
});
