import { describe, expect, it } from "vitest";
import { mergeManifestFiles } from "../../src/core/manifestMerger.js";
import type { BindingEntry, ManifestFile } from "../../src/core/cloudLayout.js";

const row = (over: Partial<ManifestFile>): ManifestFile => ({
  path: "x",
  addedAt: "t0",
  version: 1,
  hasSyncignoreMarkers: false,
  ...over,
});

describe("mergeManifestFiles", () => {
  it("больший version побеждает", () => {
    const a = row({ version: 1 });
    const b = row({ addedAt: "t1", version: 3, hasSyncignoreMarkers: true });
    const merged = mergeManifestFiles([a], [b]);
    expect(merged[0]?.version).toBe(3);
  });
});

describe("mergeManifestFiles — link bindings (docs/v2/linkBindings.md)", () => {
  it("дизъюнктные ключи bindings переживают победу любой стороны", () => {
    const a = row({ version: 5, bindings: { M1: { path: "here/a.ts", boundAt: "t1" } } });
    const b = row({ version: 2, bindings: { M2: { path: "there/b.ts", boundAt: "t2" } } });
    for (const merged of [mergeManifestFiles([a], [b]), mergeManifestFiles([b], [a])]) {
      expect(merged[0]?.bindings).toEqual({
        M1: { path: "here/a.ts", boundAt: "t1" },
        M2: { path: "there/b.ts", boundAt: "t2" },
      });
    }
  });

  it("общий ключ: побеждает более свежий boundAt, а не строка-победитель", () => {
    // Row winner is `a` (higher version) but its binding for M1 is older —
    // the rebind racing an unrelated row edit must not be lost.
    const a = row({ version: 9, bindings: { M1: { path: "old/spot.ts", boundAt: "t1" } } });
    const b = row({ version: 2, bindings: { M1: { path: "new/spot.ts", boundAt: "t5" } } });
    const merged = mergeManifestFiles([a], [b]);
    expect(merged[0]?.bindings?.M1).toEqual({ path: "new/spot.ts", boundAt: "t5" });
    expect(merged[0]?.version).toBe(9);
  });

  it("графт linkId: победитель без идентичности забирает её у проигравшего", () => {
    const winner = row({ version: 9 }); // v1-repair rebuilt the row, id lost
    const loser = row({ version: 3, linkId: "cccccccccccccccc", linkName: "метка" });
    for (const merged of [mergeManifestFiles([winner], [loser]), mergeManifestFiles([loser], [winner])]) {
      expect(merged[0]?.version).toBe(9);
      expect(merged[0]?.linkId).toBe("cccccccccccccccc");
      expect(merged[0]?.linkName).toBe("метка");
    }
  });

  it("полный tie (version, addedAt) с разными linkId детерминирован независимо от порядка аргументов", () => {
    const a = row({ linkId: "aaaaaaaaaaaaaaaa", editingBy: "M1" });
    const b = row({ linkId: "ffffffffffffffff", editingBy: "M2" });
    const ab = mergeManifestFiles([a], [b]);
    const ba = mergeManifestFiles([b], [a]);
    expect(ab[0]?.linkId).toBe("ffffffffffffffff");
    expect(ab).toEqual(ba);
  });
});

describe("mergeManifestFiles — свойства (seeded random)", () => {
  // Tiny LCG — deterministic cases without a property-testing dependency.
  let seed = 0xc0ffee;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const randomBindings = (): Record<string, BindingEntry> | undefined => {
    if (rnd() < 0.3) return undefined;
    const out: Record<string, BindingEntry> = {};
    for (const m of ["M1", "M2", "M3"]) {
      if (rnd() < 0.5) out[m] = { path: `${pick(["p", "q", "r"])}/${m}.ts`, boundAt: pick(["t1", "t2", "t3"]) };
    }
    return out;
  };

  // Distinct linkId per generated row variant: mirrors reality (fresh adds are
  // random ids) and gives full-tie rows a deterministic discriminator.
  let idCounter = 0;
  const randomRow = (path: string): ManifestFile =>
    row({
      path,
      addedAt: pick(["t0", "t1", "t2"]),
      version: Math.floor(rnd() * 4) + 1,
      linkId: `id${String(idCounter++).padStart(14, "0")}`,
      linkName: pick([undefined, "n1", "n2"]),
      bindings: randomBindings(),
    });

  it("коммутативность и идемпотентность на 200 случайных парах", () => {
    for (let i = 0; i < 200; i++) {
      const a = ["f1", "f2"].map(randomRow);
      const b = ["f1", "f3"].map(randomRow);
      const ab = mergeManifestFiles(a, b);
      const ba = mergeManifestFiles(b, a);
      expect(ab).toEqual(ba);
      expect(mergeManifestFiles(ab, ab)).toEqual(ab);
      // Convergence under re-merge with either input (412-retry shape).
      expect(mergeManifestFiles(ab, b)).toEqual(ab);
      expect(mergeManifestFiles(a, ab)).toEqual(ab);
    }
  });
});
