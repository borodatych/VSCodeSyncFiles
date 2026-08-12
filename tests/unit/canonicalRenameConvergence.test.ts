/**
 * Convergence properties of concurrent canonical renames.
 *
 * Model: two machines take the same base manifest, each applies its own batch
 * (`manifestWithRenamedKeys`), then the copies merge in every order —
 * simulating 412-retry interleavings. After the deterministic duplicate-linkId
 * repair (which rides every 412-merge in production) all replicas must agree
 * on the LIVE structure: the same linkId → path mapping, one live carrier per
 * identity. Seeded PRNG — failures reproduce.
 */
import { describe, expect, it } from "vitest";
import type { CloudManifest, ManifestFile } from "../../src/core/cloudLayout.js";
import { expandPrefixMove, manifestWithRenamedKeys } from "../../src/core/canonicalRename.js";
import { repairDuplicateLinkIds } from "../../src/core/linkIdentity.js";
import { mergeManifestFiles } from "../../src/core/manifestMerger.js";

const manifest = (files: ManifestFile[]): CloudManifest => ({
  schemaVersion: 1,
  workspaceId: "ws1",
  workspaceNote: "",
  tags: [],
  providerType: "onedrive",
  createdAt: "t0",
  updatedAt: "t0",
  machines: [],
  files,
});

const touch = (m: CloudManifest["machines"]): CloudManifest["machines"] => m;

function apply(m: CloudManifest, moves: { from: string; to: string }[], nowIso: string): CloudManifest {
  return manifestWithRenamedKeys({
    manifest: m,
    moves,
    nowIso,
    nextVersion: m.files.reduce((mx, f) => Math.max(mx, f.version), 0) + 1,
    touchMachines: touch,
  }).manifest;
}

/** Live linkId → path map after repair — the structure replicas must agree on. */
function liveStructure(files: ManifestFile[]): Map<string, string> {
  const repaired = repairDuplicateLinkIds(manifest(files), "t-repair");
  const out = new Map<string, string>();
  for (const f of repaired.files) {
    if (f.removedAt || f.linkId === undefined) continue;
    expect(out.has(f.linkId)).toBe(false); // one live carrier per identity
    out.set(f.linkId, f.path);
  }
  return out;
}

/** Tiny LCG — deterministic across runs and platforms. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function baseFiles(n: number): ManifestFile[] {
  const dirs = ["src", "src/deep", "lib", "docs"];
  return Array.from({ length: n }, (_, i) => ({
    path: `${dirs[i % dirs.length]}/f${String(i)}.ts`,
    addedAt: `2026-08-0${String((i % 8) + 1)}T00:00:00.000Z`,
    version: (i % 5) + 1,
    hasSyncignoreMarkers: false,
    linkId: String(i).padStart(16, "0"),
  }));
}

function randomMoves(files: ManifestFile[], rnd: () => number, tag: string): { from: string; to: string }[] {
  const live = files.filter((f) => !f.removedAt);
  const picked = live.filter(() => rnd() < 0.4);
  return picked.map((f, i) => ({ from: f.path, to: `moved-${tag}/${String(i)}-${f.path.split("/").pop() ?? ""}` }));
}

describe("сходимость конкурирующих канонических переездов", () => {
  it("случайные батчи × все порядки merge → одна живая структура (50 сидов)", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rnd = lcg(seed * 7919);
      const base = baseFiles(12);
      const a = apply(manifest(base), randomMoves(base, rnd, "a"), "2026-08-12T10:00:00.000Z");
      const b = apply(manifest(base), randomMoves(base, rnd, "b"), "2026-08-12T10:00:01.000Z");

      const ab = liveStructure(mergeManifestFiles(a.files, b.files));
      const ba = liveStructure(mergeManifestFiles(b.files, a.files));
      // Третья машина мержит результат с исходной копией — отставший клиент.
      const abBase = liveStructure(mergeManifestFiles(mergeManifestFiles(a.files, b.files), base));
      // Идемпотентность: повторный merge ничего не меняет.
      const abTwice = liveStructure(
        mergeManifestFiles(mergeManifestFiles(a.files, b.files), b.files),
      );

      expect(Object.fromEntries(ba), `seed=${String(seed)}`).toEqual(Object.fromEntries(ab));
      expect(Object.fromEntries(abBase), `seed=${String(seed)}`).toEqual(Object.fromEntries(ab));
      expect(Object.fromEntries(abTwice), `seed=${String(seed)}`).toEqual(Object.fromEntries(ab));
    }
  });

  it("конкурирующий rename ОДНОЙ папки на две машины: папка уезжает целиком, не «рвётся»", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const base = baseFiles(10);
      const srcMoves = expandPrefixMove(base, "src", "app");
      const srcMovesB = expandPrefixMove(base, "src", "core");
      const a = apply(manifest(base), srcMoves, "2026-08-12T10:00:00.000Z");
      const b = apply(manifest(base), srcMovesB, "2026-08-12T10:00:01.000Z");
      const merged = liveStructure(mergeManifestFiles(a.files, b.files));
      const mergedRev = liveStructure(mergeManifestFiles(b.files, a.files));
      expect(Object.fromEntries(mergedRev)).toEqual(Object.fromEntries(merged));
      // Атомарность: все бывшие src-файлы живут под ОДНИМ из двух префиксов.
      const prefixes = new Set(
        [...merged.entries()]
          .filter(([id]) => base.some((f) => f.linkId === id && f.path.startsWith("src/")))
          .map(([, path]) => path.split("/")[0]),
      );
      expect(prefixes.size, `seed=${String(seed)} prefixes=${[...prefixes].join(",")}`).toBe(1);
    }
  });

  it("вырожденное равенство: одинаковые version и timestamp двух батчей — всё равно сходится", () => {
    const base = baseFiles(8);
    const now = "2026-08-12T10:00:00.000Z";
    const a = apply(manifest(base), expandPrefixMove(base, "src", "app"), now);
    const b = apply(manifest(base), expandPrefixMove(base, "src", "core"), now);
    const ab = liveStructure(mergeManifestFiles(a.files, b.files));
    const ba = liveStructure(mergeManifestFiles(b.files, a.files));
    expect(Object.fromEntries(ba)).toEqual(Object.fromEntries(ab));
  });
});
