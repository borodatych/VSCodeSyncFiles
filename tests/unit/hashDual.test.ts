import { describe, expect, it } from "vitest";
import {
  compareMetaHash,
  computeHashDual,
  hashesEqual,
  selectHashProvider,
} from "../../src/core/hashProviders.js";
import { runHashAlgoMigrationCheck } from "../../src/core/hashMigrationCheck.js";

const buf = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("computeHashDual", () => {
  it("returns lowercase 64-char hex digests for both algorithms", () => {
    const dual = computeHashDual(buf("hello world"));
    expect(dual.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dual.blake3).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches selectHashProvider output for sha256", () => {
    const dual = computeHashDual(buf("alpha"));
    const sha = selectHashProvider("sha256").hash(buf("alpha"));
    expect(dual.sha256).toBe(sha);
  });

  it("blake3 differs from sha256 when @noble/hashes is installed", () => {
    const dual = computeHashDual(buf("alpha"));
    const blake3Provider = selectHashProvider("blake3");
    if (blake3Provider.algo === "blake3") {
      // Backend present — blake3 must be different from sha256 for any
      // non-collision input.
      expect(dual.blake3).not.toBe(dual.sha256);
    } else {
      // Backend missing — fallback returns sha256 in both fields.
      expect(dual.blake3).toBe(dual.sha256);
    }
  });
});

describe("compareMetaHash", () => {
  it("uses BLAKE3 when meta entry has hashBlake3 and preferred=blake3", () => {
    const dual = computeHashDual(buf("payload"));
    expect(
      compareMetaHash({
        metaSha256: dual.sha256,
        metaBlake3: dual.blake3,
        candidate: dual,
        preferred: "blake3",
      }),
    ).toBe(true);
  });

  it("falls back to sha256 when preferred=blake3 but meta entry is legacy (no hashBlake3)", () => {
    const dual = computeHashDual(buf("payload"));
    expect(
      compareMetaHash({
        metaSha256: dual.sha256,
        candidate: dual,
        preferred: "blake3",
      }),
    ).toBe(true);
  });

  it("uses sha256 when preferred=sha256 even if meta has hashBlake3", () => {
    const dual = computeHashDual(buf("payload"));
    expect(
      compareMetaHash({
        metaSha256: dual.sha256,
        metaBlake3: dual.blake3,
        candidate: dual,
        preferred: "sha256",
      }),
    ).toBe(true);
  });

  it("returns false on tampered candidate", () => {
    const original = computeHashDual(buf("payload"));
    const tampered = computeHashDual(buf("payload-modified"));
    expect(
      compareMetaHash({
        metaSha256: original.sha256,
        candidate: tampered,
        preferred: "sha256",
      }),
    ).toBe(false);
  });
});

describe("hashesEqual", () => {
  it("returns true on identical hashes", () => {
    expect(hashesEqual("abcd", "abcd")).toBe(true);
  });
  it("returns false on length mismatch", () => {
    expect(hashesEqual("abcd", "abc")).toBe(false);
  });
  it("returns false on different content", () => {
    expect(hashesEqual("abcd", "abce")).toBe(false);
  });
});

describe("runHashAlgoMigrationCheck", () => {
  const sha = "0".repeat(64);
  const b3 = "1".repeat(64);

  it("reports safeToSwitchToBlake3 when every entry has hashBlake3", () => {
    const r = runHashAlgoMigrationCheck([
      {
        workspaceId: "ws1",
        entries: [
          { hash: sha, hashBlake3: b3 },
          { hash: sha, hashBlake3: b3 },
        ],
      },
    ]);
    expect(r.safeToSwitchToBlake3).toBe(true);
    expect(r.perWorkspace[0]?.ratioWithBlake3).toBe(1);
  });

  it("reports unsafe when at least one entry is missing hashBlake3", () => {
    const r = runHashAlgoMigrationCheck([
      {
        workspaceId: "ws1",
        entries: [{ hash: sha, hashBlake3: b3 }, { hash: sha }],
      },
    ]);
    expect(r.safeToSwitchToBlake3).toBe(false);
    expect(r.perWorkspace[0]?.ratioWithBlake3).toBe(0.5);
  });

  it("rejects non-hex hashBlake3 strings (defensive against corruption)", () => {
    const r = runHashAlgoMigrationCheck([
      { workspaceId: "ws1", entries: [{ hash: sha, hashBlake3: "not-hex" }] },
    ]);
    expect(r.perWorkspace[0]?.withBlake3).toBe(0);
  });

  it("aggregates across multiple workspaces", () => {
    const r = runHashAlgoMigrationCheck([
      { workspaceId: "ws1", entries: [{ hash: sha, hashBlake3: b3 }] },
      { workspaceId: "ws2", entries: [{ hash: sha }] },
    ]);
    expect(r.totalWorkspaces).toBe(2);
    expect(r.totalEntries).toBe(2);
    expect(r.totalWithBlake3).toBe(1);
    expect(r.ratioWithBlake3).toBe(0.5);
    expect(r.safeToSwitchToBlake3).toBe(false);
  });

  it("treats empty workspaces as safe", () => {
    const r = runHashAlgoMigrationCheck([{ workspaceId: "ws1", entries: [] }]);
    expect(r.perWorkspace[0]?.ratioWithBlake3).toBe(1);
    expect(r.safeToSwitchToBlake3).toBe(true);
  });
});
