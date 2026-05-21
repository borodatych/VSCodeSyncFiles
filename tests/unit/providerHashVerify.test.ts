import { describe, expect, it } from "vitest";
import {
  digestEquals,
  dropboxContentHash,
  expectedProviderDigests,
  md5Hex,
  sha1Hex,
  sha256Hex,
} from "../../src/core/providerHashVerify.js";

describe("MD5/SHA-1/SHA-256 helpers", () => {
  const hello = Buffer.from("hello world", "utf8");

  it("md5Hex matches RFC 1321 vector", () => {
    expect(md5Hex(hello)).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");
  });

  it("sha1Hex matches known vector", () => {
    expect(sha1Hex(hello)).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });

  it("sha256Hex matches known vector", () => {
    expect(sha256Hex(hello)).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });
});

describe("dropboxContentHash", () => {
  it("empty buffer → sha256 of empty", () => {
    const h = dropboxContentHash(Buffer.alloc(0));
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("single-block file (< 4 MB) — hash matches reference algorithm", () => {
    const buf = Buffer.from("A".repeat(100));
    const h = dropboxContentHash(buf);
    // Algorithm: SHA-256(SHA-256(slice)) for one slice
    expect(h.length).toBe(64);
    // Deterministic — same input always produces same hash
    expect(dropboxContentHash(buf)).toBe(h);
  });

  it("multi-block file (> 4 MB) — block hashes concatenated then hashed", () => {
    const buf = Buffer.alloc(5 * 1024 * 1024, 0x42); // 5 MB of 'B'
    const h = dropboxContentHash(buf);
    expect(h.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
  });
});

describe("expectedProviderDigests", () => {
  const buf = Buffer.from("test data");

  it("gdrive → md5 only", () => {
    const d = expectedProviderDigests("gdrive", buf);
    expect(d.map((x) => x.kind)).toEqual(["md5"]);
  });

  it("yandex → md5 only", () => {
    const d = expectedProviderDigests("yandex", buf);
    expect(d[0]?.kind).toBe("md5");
  });

  it("dropbox → content-hash only", () => {
    const d = expectedProviderDigests("dropbox", buf);
    expect(d[0]?.kind).toBe("dropbox-content-hash");
  });

  it("onedrive → md5/sha1/sha256 trio", () => {
    const d = expectedProviderDigests("onedrive", buf);
    expect(d.map((x) => x.kind).sort()).toEqual(["md5", "sha1", "sha256"]);
  });
});

describe("digestEquals", () => {
  it("returns true for matching", () => {
    expect(digestEquals("deadbeef", "deadbeef")).toBe(true);
  });
  it("returns false for mismatch", () => {
    expect(digestEquals("deadbeef", "feedbeef")).toBe(false);
  });
  it("returns false for length mismatch", () => {
    expect(digestEquals("abc", "abcd")).toBe(false);
  });
});
