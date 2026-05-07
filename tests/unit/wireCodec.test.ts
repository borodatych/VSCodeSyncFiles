/**
 * Tests for the wire-codec helpers (gzip / zstd / raw selection).
 */
import { describe, it, expect } from "vitest";
import {
  assertSupportedCodec,
  chooseWireCodec,
  describeCodec,
  detectWireCodec,
  flagsForCodec,
} from "../../src/core/wireCodec.js";

describe("detectWireCodec", () => {
  it("returns raw for empty flags", () => {
    expect(detectWireCodec({})).toBe("raw");
  });

  it("returns gzip / zstd when corresponding flag is set", () => {
    expect(detectWireCodec({ wireGzip: true })).toBe("gzip");
    expect(detectWireCodec({ wireZstd: true })).toBe("zstd");
  });

  it("throws when both codec flags are set (mutually exclusive)", () => {
    expect(() => detectWireCodec({ wireGzip: true, wireZstd: true })).toThrow(/invalid meta entry/);
  });
});

describe("flagsForCodec / round-trip", () => {
  it("round-trips raw / gzip / zstd", () => {
    expect(detectWireCodec(flagsForCodec("raw"))).toBe("raw");
    expect(detectWireCodec(flagsForCodec("gzip"))).toBe("gzip");
    expect(detectWireCodec(flagsForCodec("zstd"))).toBe("zstd");
  });

  it("flagsForCodec(raw) returns no flags (smallest meta footprint)", () => {
    expect(flagsForCodec("raw")).toEqual({});
  });
});

describe("chooseWireCodec", () => {
  it("never compresses when compressUploads is off", () => {
    expect(
      chooseWireCodec(10_000, { compressUploads: false, zstdAvailable: true }),
    ).toBe("raw");
  });

  it("skips compression for small payloads (< 1 KiB)", () => {
    expect(
      chooseWireCodec(500, { compressUploads: true, zstdAvailable: true }),
    ).toBe("raw");
  });

  it("prefers zstd over gzip when both available", () => {
    expect(
      chooseWireCodec(10_000, { compressUploads: true, zstdAvailable: true }),
    ).toBe("zstd");
  });

  it("falls back to gzip when zstd is not available", () => {
    expect(
      chooseWireCodec(10_000, { compressUploads: true, zstdAvailable: false }),
    ).toBe("gzip");
  });

  it("uses 1024 as the exact threshold (boundary check)", () => {
    expect(
      chooseWireCodec(1024, { compressUploads: true, zstdAvailable: false }),
    ).toBe("gzip");
    expect(
      chooseWireCodec(1023, { compressUploads: true, zstdAvailable: false }),
    ).toBe("raw");
  });
});

describe("describeCodec", () => {
  it("matches the canonical names", () => {
    expect(describeCodec("raw")).toBe("raw");
    expect(describeCodec("gzip")).toBe("gzip");
    expect(describeCodec("zstd")).toBe("zstd");
  });
});

describe("assertSupportedCodec", () => {
  it("accepts raw / gzip by default", () => {
    expect(() => { assertSupportedCodec({}); }).not.toThrow();
    expect(() => { assertSupportedCodec({ wireGzip: true }); }).not.toThrow();
  });

  it("rejects wireZstd until v2.3 read-path lands", () => {
    expect(() => { assertSupportedCodec({ wireZstd: true }); }).toThrow(/zstd/);
  });

  it("rejects both flags set (schema corruption)", () => {
    expect(() => {
      assertSupportedCodec({ wireGzip: true, wireZstd: true });
    }).toThrow();
  });

  it("respects custom supported list (future builds with zstd)", () => {
    expect(() => {
      assertSupportedCodec({ wireZstd: true }, ["raw", "gzip", "zstd"]);
    }).not.toThrow();
  });
});
