/**
 * Tests for the v2.2 key-envelope helpers — pure data-shape checks plus
 * round-trips for the «none» (backward-compat) source.
 */
import { describe, it, expect } from "vitest";
import {
  KeyEnvelopeNotImplementedError,
  b64ToBytes,
  bytesToB64,
  constantTimeEqual,
  deriveWebauthnKek,
  envelopeNoneFromRawKey,
  isKeyEnvelope,
  rawKeyFromNoneEnvelope,
} from "../../src/core/keyEnvelope.js";

describe("isKeyEnvelope", () => {
  it("accepts a well-formed `none` envelope", () => {
    expect(isKeyEnvelope({ v: 1, source: "none", ivB64: "", cipherB64: "AAAA" })).toBe(true);
  });

  it("accepts a well-formed passphrase envelope", () => {
    expect(
      isKeyEnvelope({
        v: 1,
        source: "passphrase",
        ivB64: "iv",
        cipherB64: "ciph",
        saltB64: "salt",
        iterations: 200_000,
      }),
    ).toBe(true);
  });

  it("rejects null / non-object", () => {
    expect(isKeyEnvelope(null)).toBe(false);
    expect(isKeyEnvelope("string")).toBe(false);
    expect(isKeyEnvelope(42)).toBe(false);
  });

  it("rejects wrong schema version", () => {
    expect(isKeyEnvelope({ v: 2, source: "none", ivB64: "", cipherB64: "x" })).toBe(false);
  });

  it("rejects unknown source", () => {
    expect(isKeyEnvelope({ v: 1, source: "magic", ivB64: "", cipherB64: "x" })).toBe(false);
  });

  it("rejects passphrase envelope without salt or iterations", () => {
    expect(
      isKeyEnvelope({ v: 1, source: "passphrase", ivB64: "iv", cipherB64: "c" }),
    ).toBe(false);
    expect(
      isKeyEnvelope({
        v: 1,
        source: "passphrase",
        ivB64: "iv",
        cipherB64: "c",
        saltB64: "s",
        iterations: 100,
      }),
    ).toBe(false);
  });
});

describe("envelopeNoneFromRawKey ↔ rawKeyFromNoneEnvelope", () => {
  it("round-trips a 32-byte key", () => {
    const key = new Uint8Array(32);
    for (let i = 0; i < key.length; i++) key[i] = i + 1;
    const env = envelopeNoneFromRawKey(key);
    expect(env.source).toBe("none");
    const back = rawKeyFromNoneEnvelope(env);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(key));
  });

  it("rawKeyFromNoneEnvelope returns null for non-`none` envelope", () => {
    const env = {
      v: 1 as const,
      source: "passphrase" as const,
      ivB64: "x",
      cipherB64: "y",
      saltB64: "s",
      iterations: 200_000,
    };
    expect(rawKeyFromNoneEnvelope(env)).toBeNull();
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const samples: Uint8Array[] = [
      new Uint8Array([0]),
      new Uint8Array([0, 1, 2, 3]),
      new Uint8Array([255, 254, 253, 252]),
      new Uint8Array(64).map((_, i) => i),
    ];
    for (const s of samples) {
      expect(Array.from(b64ToBytes(bytesToB64(s)))).toEqual(Array.from(s));
    }
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it("returns false for different content of same length", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("returns false for different lengths (no early return on prefix-equal)", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 0]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});

describe("deriveWebauthnKek (real impl)", () => {
  const prf = new Uint8Array(32).fill(0x42);
  const salt = new Uint8Array(16).fill(0x01);

  it("derives a deterministic 32-byte KEK", () => {
    const a = deriveWebauthnKek(prf, salt);
    const b = deriveWebauthnKek(prf, salt);
    expect(a.length).toBe(32);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  it("different salts produce different KEKs", () => {
    const a = deriveWebauthnKek(prf, salt);
    const b = deriveWebauthnKek(prf, new Uint8Array(16).fill(0x02));
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });

  it("different PRF inputs produce different KEKs", () => {
    const a = deriveWebauthnKek(prf, salt);
    const b = deriveWebauthnKek(new Uint8Array(32).fill(0x99), salt);
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });

  it("rejects too-short PRF output", () => {
    expect(() => deriveWebauthnKek(new Uint8Array(16), salt)).toThrow(/too short/);
  });
});

describe("KeyEnvelopeNotImplementedError sentinel still exported", () => {
  it("is constructible (kept for callers gated behind future paths)", () => {
    const e = new KeyEnvelopeNotImplementedError("test reason");
    expect(e.name).toBe("KeyEnvelopeNotImplementedError");
  });
});
