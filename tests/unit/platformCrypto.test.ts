/**
 * Unit tests for platformCrypto.ts — both Node and Web (SubtleCrypto) implementations.
 * The Web implementation is tested using the globalThis.crypto available in Vitest
 * (Node 18+ ships a compliant SubtleCrypto as globalThis.crypto.subtle).
 */
import { describe, it, expect } from "vitest";
import { createNodeCrypto, createWebCrypto } from "../../src/core/platformCrypto.js";
import type { ICrypto } from "../../src/core/platformCrypto.js";

// ─── Shared contract tests ────────────────────────────────────────────────────

function runCryptoContractTests(label: string, factory: () => ICrypto): void {
  describe(label, () => {
    it("generateKey produces 32-byte key", async () => {
      const c = factory();
      const key = await c.generateKey();
      expect(key.length).toBe(32);
    });

    it("randomBytes produces requested length", () => {
      const c = factory();
      const r = c.randomBytes(16);
      expect(r.length).toBe(16);
      const r2 = c.randomBytes(16);
      // With overwhelming probability, two random 128-bit values differ
      expect(Buffer.from(r).equals(Buffer.from(r2))).toBe(false);
    });

    it("sha256 produces 32-byte digest", async () => {
      const c = factory();
      const digest = await c.sha256(Buffer.from("hello"));
      expect(digest.length).toBe(32);
    });

    it("sha256 is deterministic", async () => {
      const c = factory();
      const a = await c.sha256(Buffer.from("deterministic"));
      const b = await c.sha256(Buffer.from("deterministic"));
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    });

    it("encrypt → decrypt round-trip (empty plaintext)", async () => {
      const c = factory();
      const key = await c.generateKey();
      const plaintext = Buffer.alloc(0);
      const blob = await c.encrypt(key, plaintext);
      const decrypted = await c.decrypt(key, blob);
      expect(Buffer.from(decrypted).equals(plaintext)).toBe(true);
    });

    it("encrypt → decrypt round-trip (short plaintext)", async () => {
      const c = factory();
      const key = await c.generateKey();
      const plaintext = Buffer.from("hello VSCodeSync!");
      const blob = await c.encrypt(key, plaintext);
      const decrypted = await c.decrypt(key, blob);
      expect(Buffer.from(decrypted).toString()).toBe("hello VSCodeSync!");
    });

    it("encrypt → decrypt round-trip (binary data)", async () => {
      const c = factory();
      const key = await c.generateKey();
      const plaintext = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      const blob = await c.encrypt(key, plaintext);
      const decrypted = await c.decrypt(key, blob);
      expect(Buffer.from(decrypted).equals(plaintext)).toBe(true);
    });

    it("encrypted blob is larger than plaintext (IV + authTag overhead)", async () => {
      const c = factory();
      const key = await c.generateKey();
      const plaintext = Buffer.from("test payload");
      const blob = await c.encrypt(key, plaintext);
      // At minimum IV(12) + authTag(16) = 28 bytes overhead
      expect(blob.length).toBeGreaterThan(plaintext.length);
    });

    it("decrypt with wrong key throws", async () => {
      const c = factory();
      const key = await c.generateKey();
      const wrongKey = await c.generateKey();
      const blob = await c.encrypt(key, Buffer.from("secret"));
      await expect(c.decrypt(wrongKey, blob)).rejects.toThrow();
    });

    it("decrypt with tampered ciphertext throws", async () => {
      const c = factory();
      const key = await c.generateKey();
      const blob = await c.encrypt(key, Buffer.from("secret"));
      const tampered = Buffer.from(blob);
      tampered[15] ^= 0xff; // flip bits in ciphertext area
      await expect(c.decrypt(key, tampered)).rejects.toThrow();
    });

    it("decrypt with too-short blob throws", async () => {
      const c = factory();
      const key = await c.generateKey();
      const tooShort = Buffer.alloc(10);
      await expect(c.decrypt(key, tooShort)).rejects.toThrow();
    });

    it("each encrypt call produces different ciphertext (random IV)", async () => {
      const c = factory();
      const key = await c.generateKey();
      const plaintext = Buffer.from("same plaintext");
      const blob1 = await c.encrypt(key, plaintext);
      const blob2 = await c.encrypt(key, plaintext);
      // Different IVs → different ciphertexts
      expect(Buffer.from(blob1).equals(Buffer.from(blob2))).toBe(false);
    });
  });
}

// ─── Cross-implementation compatibility ──────────────────────────────────────

describe("platformCrypto cross-implementation compatibility", () => {
  it("Node-encrypted blob decrypts with Web implementation", async () => {
    const node = createNodeCrypto();
    const web = createWebCrypto();
    const key = await node.generateKey();
    const plaintext = Buffer.from("cross-platform test");
    const blob = await node.encrypt(key, plaintext);
    const decrypted = await web.decrypt(key, blob);
    expect(Buffer.from(decrypted).toString()).toBe("cross-platform test");
  });

  it("Web-encrypted blob decrypts with Node implementation", async () => {
    const node = createNodeCrypto();
    const web = createWebCrypto();
    const key = await web.generateKey();
    const plaintext = Buffer.from("reverse cross-platform");
    const blob = await web.encrypt(key, plaintext);
    const decrypted = await node.decrypt(key, blob);
    expect(Buffer.from(decrypted).toString()).toBe("reverse cross-platform");
  });

  it("sha256 produces identical digests in both implementations", async () => {
    const node = createNodeCrypto();
    const web = createWebCrypto();
    const data = Buffer.from("sha256 cross-check");
    const nodeDigest = await node.sha256(data);
    const webDigest = await web.sha256(data);
    expect(Buffer.from(nodeDigest).equals(Buffer.from(webDigest))).toBe(true);
  });
});

// ─── Run contract tests for both implementations ──────────────────────────────

runCryptoContractTests("ICrypto (Node/desktop)", () => createNodeCrypto());
runCryptoContractTests("ICrypto (Web/SubtleCrypto)", () => createWebCrypto());
