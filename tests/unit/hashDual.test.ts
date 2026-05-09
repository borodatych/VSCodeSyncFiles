import { describe, expect, it } from "vitest";
import {
  compareMetaHash,
  computeHashDual,
  hashesEqual,
  selectHashProvider,
} from "../../src/core/hashProviders.js";
import {
  planBlake3MigrationTasks,
  runHashAlgoMigrationCheck,
} from "../../src/core/hashMigrationCheck.js";
import {
  hashCanonicalBuffer,
  hashCanonicalBufferDual,
} from "../../src/utils/hash.js";

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

describe("hashCanonicalBufferDual", () => {
  const cfg = { lineEnding: "lf" as const };

  it("SHA-256 matches single-hash hashCanonicalBuffer for the same canonical input", () => {
    const text = Buffer.from("alpha\nbeta\n", "utf8");
    const single = hashCanonicalBuffer(text, "file.txt", cfg);
    const dual = hashCanonicalBufferDual(text, "file.txt", cfg);
    expect(dual.sha256).toBe(single);
  });

  it("normalises CRLF → LF before hashing (both algorithms)", () => {
    const crlf = Buffer.from("alpha\r\nbeta\r\n", "utf8");
    const lf = Buffer.from("alpha\nbeta\n", "utf8");
    const dCrlf = hashCanonicalBufferDual(crlf, "file.txt", cfg);
    const dLf = hashCanonicalBufferDual(lf, "file.txt", cfg);
    expect(dCrlf.sha256).toBe(dLf.sha256);
    expect(dCrlf.blake3).toBe(dLf.blake3);
  });

  it("hashes binary buffers as-is (no canonicalisation)", () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const dual = hashCanonicalBufferDual(bin, "file.bin", cfg);
    expect(dual.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dual.blake3).toMatch(/^[0-9a-f]{64}$/);
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

describe("planBlake3MigrationTasks", () => {
  const sha = "0".repeat(64);
  const b3 = "1".repeat(64);

  it("emits a task per entry missing hashBlake3 with relPath", () => {
    const r = planBlake3MigrationTasks([
      {
        workspaceId: "ws1",
        entries: [
          { relPath: "a.ts", hash: sha, hashBlake3: b3 }, // skip
          { relPath: "b.ts", hash: sha }, // include
          { relPath: "c.ts", hash: sha, hashBlake3: "not-hex" }, // include (corrupt)
        ],
      },
    ]);
    expect(r.totalTasks).toBe(2);
    expect(r.tasks.map((t) => t.relPath)).toEqual(["b.ts", "c.ts"]);
    expect(r.affectedWorkspaceIds).toEqual(["ws1"]);
  });

  it("skips entries without relPath (legacy meta)", () => {
    const r = planBlake3MigrationTasks([
      { workspaceId: "ws1", entries: [{ hash: sha }] },
    ]);
    expect(r.totalTasks).toBe(0);
  });

  it("orders tasks by (workspaceId, relPath) deterministically", () => {
    const r = planBlake3MigrationTasks([
      {
        workspaceId: "ws2",
        entries: [
          { relPath: "z.ts", hash: sha },
          { relPath: "a.ts", hash: sha },
        ],
      },
      {
        workspaceId: "ws1",
        entries: [
          { relPath: "m.ts", hash: sha },
          { relPath: "b.ts", hash: sha },
        ],
      },
    ]);
    expect(r.tasks.map((t) => `${t.workspaceId}:${t.relPath}`)).toEqual([
      "ws1:b.ts",
      "ws1:m.ts",
      "ws2:a.ts",
      "ws2:z.ts",
    ]);
  });

  it("affectedWorkspaceIds is sorted and deduped", () => {
    const r = planBlake3MigrationTasks([
      { workspaceId: "ws-z", entries: [{ relPath: "x", hash: sha }] },
      { workspaceId: "ws-a", entries: [{ relPath: "y", hash: sha }] },
      { workspaceId: "ws-m", entries: [{ relPath: "z", hash: sha, hashBlake3: b3 }] }, // no task
    ]);
    expect(r.affectedWorkspaceIds).toEqual(["ws-a", "ws-z"]);
  });

  it("empty input → empty plan", () => {
    const r = planBlake3MigrationTasks([]);
    expect(r.totalTasks).toBe(0);
    expect(r.affectedWorkspaceIds).toEqual([]);
  });
});
