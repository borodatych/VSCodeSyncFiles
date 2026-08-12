/**
 * Canonical path editing — the pure manifest transform. The load-bearing
 * pieces: tombstone + heir shape (1.1.x replay compatibility), the SINGLE
 * batch version (folder-atomic convergence), explicit identity
 * materialisation (the deterministic backfill depends on the path), and the
 * heir never inheriting `removedAt` from a tombstone parked at its target.
 */
import { describe, expect, it } from "vitest";
import type { CloudManifest, ManifestFile } from "../../src/core/cloudLayout.js";
import {
  expandPrefixMove,
  manifestWithRenamedKeys,
  migrateFolderBindingsForPrefixMoves,
  remapKeyThroughPrefixMoves,
} from "../../src/core/canonicalRename.js";
import { deterministicLinkId } from "../../src/core/linkIdentity.js";

const row = (over: Partial<ManifestFile> & { path: string }): ManifestFile => ({
  addedAt: "2026-08-01T00:00:00.000Z",
  version: 1,
  hasSyncignoreMarkers: false,
  ...over,
});

const manifest = (files: ManifestFile[], folderBindings?: CloudManifest["folderBindings"]): CloudManifest => ({
  schemaVersion: 1,
  workspaceId: "ws1",
  workspaceNote: "",
  tags: [],
  providerType: "onedrive",
  createdAt: "t0",
  updatedAt: "t0",
  machines: [],
  files,
  ...(folderBindings !== undefined ? { folderBindings } : {}),
});

const touch = (m: CloudManifest["machines"]): CloudManifest["machines"] => m;
const NOW = "2026-08-12T12:00:00.000Z";

function rename(m: CloudManifest, moves: { from: string; to: string }[], over: Partial<Parameters<typeof manifestWithRenamedKeys>[0]> = {}) {
  return manifestWithRenamedKeys({
    manifest: m,
    moves,
    nowIso: NOW,
    nextVersion: m.files.reduce((mx, f) => Math.max(mx, f.version), 0) + 1,
    touchMachines: touch,
    ...over,
  });
}

describe("manifestWithRenamedKeys — форма пары", () => {
  it("tombstone + наследник: renamedFrom, наследование идентичности, метки и привязок", () => {
    const src = row({
      path: "src/a.ts",
      version: 3,
      linkId: "aabbccdd00112233",
      linkName: "моя метка",
      hasSyncignoreMarkers: true,
      bindings: { M2: { path: "php/a.ts", boundAt: "t1" } },
    });
    const out = rename(manifest([src]), [{ from: "src/a.ts", to: "lib/a.ts" }]);
    expect(out.applied).toEqual([{ from: "src/a.ts", to: "lib/a.ts" }]);
    const tomb = out.manifest.files.find((f) => f.path === "src/a.ts");
    const heir = out.manifest.files.find((f) => f.path === "lib/a.ts");
    expect(tomb?.removedAt).toBe(NOW);
    expect(heir).toMatchObject({
      renamedFrom: "src/a.ts",
      renamedAt: NOW,
      linkId: "aabbccdd00112233",
      linkName: "моя метка",
      hasSyncignoreMarkers: true,
      bindings: { M2: { path: "php/a.ts", boundAt: "t1" } },
    });
    expect(heir?.removedAt).toBeUndefined();
    // Copy-on-write: the input manifest is untouched.
    expect(src.removedAt).toBeUndefined();
  });

  it("легаси-строка без linkId: детерминированная идентичность материализуется в ОБЕ строки пары", () => {
    // Бэкфилл sha256(path+addedAt) зависит от пути — после переезда он бы
    // разошёлся, и идентичность порвалась бы.
    const src = row({ path: "src/a.ts" });
    const expected = deterministicLinkId("src/a.ts", src.addedAt);
    const out = rename(manifest([src]), [{ from: "src/a.ts", to: "lib/a.ts" }]);
    expect(out.manifest.files.find((f) => f.path === "src/a.ts")?.linkId).toBe(expected);
    expect(out.manifest.files.find((f) => f.path === "lib/a.ts")?.linkId).toBe(expected);
  });

  it("дефолтная метка следует за именем файла, кастомная — остаётся", () => {
    const def = row({ path: "src/a.ts", linkId: "1".repeat(16), linkName: "a.ts" });
    const custom = row({ path: "src/b.ts", linkId: "2".repeat(16), linkName: "главный конфиг" });
    const out = rename(manifest([def, custom]), [
      { from: "src/a.ts", to: "lib/renamed.ts" },
      { from: "src/b.ts", to: "lib/b.ts" },
    ]);
    expect(out.manifest.files.find((f) => f.path === "lib/renamed.ts")?.linkName).toBe("renamed.ts");
    expect(out.manifest.files.find((f) => f.path === "lib/b.ts")?.linkName).toBe("главный конфиг");
  });

  it("наследник, встающий на tombstone-путь, НЕ наследует removedAt (спред-баг)", () => {
    const dead = row({ path: "lib/a.ts", removedAt: "t1", version: 7 });
    const live = row({ path: "src/a.ts", version: 2, linkId: "3".repeat(16) });
    const out = rename(manifest([dead, live]), [{ from: "src/a.ts", to: "lib/a.ts" }]);
    const heir = out.manifest.files.find((f) => f.path === "lib/a.ts");
    expect(heir?.removedAt).toBeUndefined();
    expect(heir?.renamedFrom).toBe("src/a.ts");
    // Ровно одна строка на путь.
    expect(out.manifest.files.filter((f) => f.path === "lib/a.ts")).toHaveLength(1);
  });
});

describe("manifestWithRenamedKeys — батч-инвариант", () => {
  it("ВСЕ строки батча несут один version и один timestamp — папка сходится атомарно", () => {
    const files = [
      row({ path: "src/a.ts", version: 2, linkId: "a".repeat(16) }),
      row({ path: "src/b.ts", version: 9, linkId: "b".repeat(16) }),
      row({ path: "src/deep/c.ts", version: 4, linkId: "c".repeat(16) }),
    ];
    const out = rename(manifest(files), expandPrefixMove(files, "src", "lib"));
    const touched = out.manifest.files;
    expect(touched).toHaveLength(6);
    const versions = new Set(touched.map((f) => f.version));
    expect(versions.size).toBe(1);
    // Выше максимума затронутых строк.
    expect([...versions][0]).toBeGreaterThan(9);
    expect(out.batchVersion).toBe([...versions][0]);
    const stamps = new Set(
      touched.map((f) => f.removedAt ?? f.renamedAt),
    );
    expect(stamps).toEqual(new Set([NOW]));
  });

  it("пропуски: identity, missing, collision, своп-цикл", () => {
    const files = [
      row({ path: "a.ts", linkId: "a".repeat(16) }),
      row({ path: "b.ts", linkId: "b".repeat(16) }),
      row({ path: "busy.ts", linkId: "d".repeat(16) }),
    ];
    const m = manifest(files);
    const out = rename(m, [
      { from: "a.ts", to: "a.ts" }, // identity
      { from: "ghost.ts", to: "x.ts" }, // missing
      { from: "a.ts", to: "busy.ts" }, // collision с живой строкой вне батча
      { from: "b.ts", to: "a.ts" }, // своп-источник → collision
    ]);
    expect(out.applied).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["identity", "missing", "collision", "collision"]);
    // Пустой батч — тот же объект, PUT не нужен.
    expect(out.manifest).toBe(m);
  });
});

describe("migrateFolderBindingsForPrefixMoves", () => {
  it("правило машины переезжает на новый префикс, старый нейтрализуется identity-записью", () => {
    const rules: CloudManifest["folderBindings"] = {
      M2: { "src/api": { path: "php/api", boundAt: "t1" }, docs: { path: "docs", boundAt: "t1" } },
    };
    const out = migrateFolderBindingsForPrefixMoves(rules, [{ from: "src", to: "lib" }], NOW);
    expect(out?.M2["lib/api"]).toEqual({ path: "php/api", boundAt: NOW });
    // Нейтрализация: старый ключ указывает сам на себя со свежим boundAt —
    // union-merge не воскресит старое правило, и будущий файл под src/ не
    // подхватит забытый маппинг.
    expect(out?.M2["src/api"]).toEqual({ path: "src/api", boundAt: NOW });
    expect(out?.M2.docs).toEqual({ path: "docs", boundAt: "t1" });
  });

  it("без совпадений — тот же объект", () => {
    const rules: CloudManifest["folderBindings"] = { M2: { docs: { path: "d", boundAt: "t1" } } };
    expect(migrateFolderBindingsForPrefixMoves(rules, [{ from: "src", to: "lib" }], NOW)).toBe(rules);
  });
});

describe("remapKeyThroughPrefixMoves", () => {
  it("длиннейший префикс побеждает; без совпадения — ключ как был", () => {
    const moves = [
      { from: "src", to: "lib" },
      { from: "src/deep", to: "core" },
    ];
    expect(remapKeyThroughPrefixMoves("src/a.ts", moves)).toBe("lib/a.ts");
    expect(remapKeyThroughPrefixMoves("src/deep/c.ts", moves)).toBe("core/c.ts");
    expect(remapKeyThroughPrefixMoves("src", moves)).toBe("lib");
    expect(remapKeyThroughPrefixMoves("other/x.ts", moves)).toBe("other/x.ts");
  });
});
