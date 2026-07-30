/**
 * The wire codec must be an exact round trip.
 *
 * Upload is `plaintext -> [gzip] -> [encrypt] -> upload` and `_meta.hash` is
 * always the *plaintext* canonical hash. Four comparison sites in the engine
 * hashed the downloaded body as-is, so with encryption or compression enabled
 * the computed hash could never equal the stored one — those files were
 * reported as conflicting forever — and the raw wire bytes were also handed to
 * the line-ending comparison as if they were file content.
 */
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeCloudBlob, encodeCloudBlob } from "../../src/core/cloudBlobCodec.js";

const TEXT = Buffer.from("line one\nline two\nline three\n".repeat(40), "utf8");

/** Reversible stand-in for AES — the codec only needs an inverse pair. */
function xorCipher(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ 0x5a;
  return out;
}

const CRYPTO = { encrypt: xorCipher, decrypt: xorCipher };

describe("decodeCloudBlob", () => {
  it("без шифрования и сжатия возвращает те же байты", () => {
    expect(decodeCloudBlob(TEXT, false, {}).equals(TEXT)).toBe(true);
  });

  it("расшифровывает, когда ключ есть", () => {
    expect(decodeCloudBlob(xorCipher(TEXT), false, CRYPTO).equals(TEXT)).toBe(true);
  });

  it("распаковывает, когда wireGzip", () => {
    expect(decodeCloudBlob(gzipSync(TEXT), true, {}).equals(TEXT)).toBe(true);
  });

  it("порядок обратен сборке: сначала decrypt, затем gunzip", () => {
    const wire = xorCipher(gzipSync(TEXT));
    expect(decodeCloudBlob(wire, true, CRYPTO).equals(TEXT)).toBe(true);
  });

  it("обратный порядок дал бы мусор — фиксируем, что он именно такой", () => {
    // gzip(encrypt(x)) is what the *wrong* order would produce; decoding it
    // with the correct order must fail rather than silently return garbage.
    const wrongWire = gzipSync(xorCipher(TEXT));
    expect(() => decodeCloudBlob(wrongWire, true, CRYPTO)).toThrow();
  });
});

describe("encodeCloudBlob ↔ decodeCloudBlob", () => {
  const cases: { name: string; compress: boolean; crypto: boolean }[] = [
    { name: "как есть", compress: false, crypto: false },
    { name: "только сжатие", compress: true, crypto: false },
    { name: "только шифрование", compress: false, crypto: true },
    { name: "сжатие и шифрование", compress: true, crypto: true },
  ];

  for (const c of cases) {
    it(`круговой рейс: ${c.name}`, () => {
      const opts = { ...(c.crypto ? CRYPTO : {}), compressUploads: c.compress };
      const encoded = encodeCloudBlob(TEXT, "notes.txt", opts);
      const decoded = decodeCloudBlob(encoded.body, encoded.wireGzip, opts);
      expect(decoded.equals(TEXT)).toBe(true);
    });
  }

  it("сжатие включается только когда реально уменьшает объём", () => {
    const incompressible = Buffer.from("x", "utf8");
    const encoded = encodeCloudBlob(incompressible, "a.txt", { compressUploads: true });
    expect(encoded.wireGzip).toBe(false);
    expect(encoded.body.equals(incompressible)).toBe(true);
  });

  it("при выключенном сжатии wireGzip всегда false", () => {
    const encoded = encodeCloudBlob(TEXT, "notes.txt", { compressUploads: false });
    expect(encoded.wireGzip).toBe(false);
  });
});
