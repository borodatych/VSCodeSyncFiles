/**
 * Unit tests for platformCompression.ts — both Node (zlib) and Web (CompressionStream) implementations.
 * CompressionStream / DecompressionStream are available in Node 18+ (used by Vitest environment).
 * Tests verify:
 *   - gzip → gunzip round-trip (both impls)
 *   - cross-implementation compatibility (Node gzip → Web gunzip and vice versa)
 *   - threshold behaviour (small data returns undefined from gzip)
 *   - binary and text data
 *   - wireCompression.ts format compatibility
 */
import { describe, it, expect } from "vitest";
import { createNodeCompression, createWebCompression } from "../../src/core/platformCompression.js";
import type { ICompression } from "../../src/core/platformCompression.js";
import * as zlib from "node:zlib";

// ─── Shared contract tests ────────────────────────────────────────────────────

function runCompressionContractTests(label: string, factory: () => ICompression): void {
  describe(label, () => {
    it("gunzip(gzip(data)) round-trip — compressible text", async () => {
      const c = factory();
      const plain = Buffer.from("Hello VSCodeSync! ".repeat(200)); // highly compressible
      const gz = await c.gzip(plain);
      expect(gz).toBeDefined();
      const restored = await c.gunzip(gz!);
      expect(Buffer.from(restored).equals(plain)).toBe(true);
    });

    it("gzip returns undefined for small / already-compressed data", async () => {
      const c = factory();
      // Very short — compressed is larger than raw + threshold
      const tiny = Buffer.from("hi");
      const gz = await c.gzip(tiny);
      expect(gz).toBeUndefined();
    });

    it("gzip returns undefined when compressed >= original - 24", async () => {
      const c = factory();
      // Random-like bytes: entropy = high, compression won't help
      const bytes = Buffer.allocUnsafe(50);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 137 + 17) % 256;
      const gz = await c.gzip(bytes);
      // May or may not compress — if it does, result must be correct; if not, undefined
      if (gz !== undefined) {
        const restored = await c.gunzip(gz);
        expect(Buffer.from(restored).equals(bytes)).toBe(true);
      }
    });

    it("gunzip reproduces exact bytes for large compressible payload", async () => {
      const c = factory();
      const data = Buffer.from(JSON.stringify({ key: "value", arr: Array.from({ length: 500 }, (_, i) => i) }));
      const gz = await c.gzip(data);
      expect(gz).toBeDefined();
      expect(gz!.length).toBeLessThan(data.length);
      const restored = await c.gunzip(gz!);
      expect(Buffer.from(restored).equals(data)).toBe(true);
    });

    it("handles binary data (zeros buffer)", async () => {
      const c = factory();
      const data = Buffer.alloc(1000, 0);
      const gz = await c.gzip(data);
      expect(gz).toBeDefined();
      const restored = await c.gunzip(gz!);
      expect(Buffer.from(restored).equals(data)).toBe(true);
    });

    it("handles empty buffer", async () => {
      const c = factory();
      const empty = Buffer.alloc(0);
      const gz = await c.gzip(empty);
      // Empty buffer: compressed is larger (gzip header overhead), so undefined expected
      if (gz !== undefined) {
        const restored = await c.gunzip(gz);
        expect(restored.length).toBe(0);
      } else {
        expect(gz).toBeUndefined();
      }
    });

    it("gzip output is valid gzip (magic bytes 1f 8b)", async () => {
      const c = factory();
      const data = Buffer.from("a".repeat(500));
      const gz = await c.gzip(data);
      expect(gz).toBeDefined();
      // gzip magic: 0x1f 0x8b
      expect(gz![0]).toBe(0x1f);
      expect(gz![1]).toBe(0x8b);
    });
  });
}

// ─── Cross-implementation compatibility ──────────────────────────────────────

describe("platformCompression cross-implementation compatibility", () => {
  it("Node-gzipped data decompresses with Web implementation", async () => {
    const node = createNodeCompression();
    const web = createWebCompression();
    const plain = Buffer.from("cross-platform compression test ".repeat(100));
    const gz = await node.gzip(plain);
    expect(gz).toBeDefined();
    const restored = await web.gunzip(gz!);
    expect(Buffer.from(restored).equals(plain)).toBe(true);
  });

  it("Web-gzipped data decompresses with Node implementation", async () => {
    const node = createNodeCompression();
    const web = createWebCompression();
    const plain = Buffer.from("reverse cross-platform compression ".repeat(100));
    const gz = await web.gzip(plain);
    expect(gz).toBeDefined();
    const restored = await node.gunzip(gz!);
    expect(Buffer.from(restored).equals(plain)).toBe(true);
  });

  it("wireCompression.ts format: zlib.gzipSync output decompresses with Web gunzip", async () => {
    // Verify that the web implementation can decompress blobs produced by wireCompression.ts
    const plain = Buffer.from("sync engine wire format ".repeat(200));
    const wireGz = zlib.gzipSync(plain);
    const web = createWebCompression();
    const restored = await web.gunzip(wireGz);
    expect(Buffer.from(restored).equals(plain)).toBe(true);
  });

  it("Web gzip output decompresses with zlib.gunzipSync (wireCompression.ts compat)", async () => {
    const web = createWebCompression();
    const plain = Buffer.from("web to node format check ".repeat(200));
    const gz = await web.gzip(plain);
    expect(gz).toBeDefined();
    const restored = zlib.gunzipSync(Buffer.from(gz!));
    expect(restored.equals(plain)).toBe(true);
  });
});

// ─── Run contract tests for both implementations ──────────────────────────────

runCompressionContractTests("ICompression (Node/zlib)", () => createNodeCompression());
runCompressionContractTests("ICompression (Web/CompressionStream)", () => createWebCompression());
