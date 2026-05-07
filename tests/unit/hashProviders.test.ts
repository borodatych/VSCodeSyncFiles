/**
 * Tests for the hash-provider abstraction. SHA-256 always present; BLAKE3
 * runs only if `@noble/hashes` was installed (skipped silently otherwise).
 */
import { describe, it, expect } from "vitest";
import {
  createBlake3ProviderSync,
  createSha256Provider,
  hashesEqual,
  selectHashProvider,
} from "../../src/core/hashProviders.js";

const SAMPLE = new TextEncoder().encode("vscodesync test vector");

describe("createSha256Provider", () => {
  it("hashes empty buffer to the canonical SHA-256 of empty", () => {
    const p = createSha256Provider();
    expect(p.algo).toBe("sha256");
    expect(p.hash(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches a known vector", () => {
    const p = createSha256Provider();
    expect(p.hash(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic across calls", () => {
    const p = createSha256Provider();
    expect(p.hash(SAMPLE)).toBe(p.hash(SAMPLE));
  });
});

describe("createBlake3ProviderSync (optional)", () => {
  it("either returns a working provider or null when dep absent", () => {
    const b3 = createBlake3ProviderSync();
    if (!b3) return; // dep not installed in this build — skip
    expect(b3.algo).toBe("blake3");
    // BLAKE3("") canonical: af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262
    expect(b3.hash(new Uint8Array())).toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  it("produces 32-byte (64 hex char) digests", () => {
    const b3 = createBlake3ProviderSync();
    if (!b3) return;
    expect(b3.hash(SAMPLE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("selectHashProvider", () => {
  it("returns sha256 when requested", () => {
    expect(selectHashProvider("sha256").algo).toBe("sha256");
  });

  it("returns blake3 when requested and dep present, else sha256", () => {
    const got = selectHashProvider("blake3");
    expect(["blake3", "sha256"]).toContain(got.algo);
  });
});

describe("hashesEqual", () => {
  it("true for identical hex", () => {
    expect(hashesEqual("ab", "ab")).toBe(true);
  });

  it("false for different content of same length", () => {
    expect(hashesEqual("ab", "ac")).toBe(false);
  });

  it("false for different lengths", () => {
    expect(hashesEqual("ab", "abc")).toBe(false);
  });
});
