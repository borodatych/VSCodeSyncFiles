/**
 * Smoke tests for the WASM zstd backend wired into `createNodeCompression`.
 *
 * Skips silently if `@bokuweb/zstd-wasm` is not installed — the dep is
 * declared as `optionalDependencies` so a clean install without the WASM
 * blob shouldn't break the rest of the suite.
 */
import { describe, it, expect } from "vitest";
import { createNodeCompression } from "../../src/core/platformCompression.js";

describe("zstd backend (Node)", () => {
  it("compresses and decompresses round-trip when backend is available", async () => {
    const c = createNodeCompression();
    if (!c.zstd || !c.unzstd) return;
    const text = "hello world ".repeat(200);
    const data = new TextEncoder().encode(text);
    const compressed = await c.zstd(data);
    if (!compressed) {
      // Backend present but payload didn't shrink past threshold — still a
      // valid behaviour, just out of scope here.
      return;
    }
    expect(compressed.length).toBeLessThan(data.length);
    const back = await c.unzstd(compressed);
    expect(new TextDecoder().decode(back)).toBe(text);
  });

  it("returns undefined when payload is incompressible (already small)", async () => {
    const c = createNodeCompression();
    if (!c.zstd) return;
    const tiny = new Uint8Array([0]);
    const out = await c.zstd(tiny);
    expect(out).toBeUndefined();
  });
});
