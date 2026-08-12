/**
 * Orphan GC planner: only objects no live key explains AND with every dating
 * anchor older than the retention window are collectable; anything fresh,
 * chained, or undatable stays untouched.
 */
import { describe, expect, it } from "vitest";
import type { ManifestFile } from "../../src/core/cloudLayout.js";
import { planOrphanGc, type OrphanGcInput } from "../../src/core/plan/planOrphanGc.js";

const ROOT = "VSCodeSyncFiles/ws1";
const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const WEEK = 7 * 24 * 3600_000;
const OLD = "2026-07-01T00:00:00.000Z"; // far beyond the window
const FRESH = "2026-08-12T09:00:00.000Z"; // hours ago

function row(partial: Partial<ManifestFile> & { path: string }): ManifestFile {
  return { addedAt: OLD, version: 1, hasSyncignoreMarkers: false, ...partial };
}

function base(over: Partial<OrphanGcInput> = {}): OrphanGcInput {
  return {
    workspaceCloudRoot: ROOT,
    listed: [],
    manifestFiles: [],
    metaFiles: {},
    nowMs: NOW,
    minAgeMs: WEEK,
    ...over,
  };
}

describe("planOrphanGc — блобы", () => {
  it("живой ключ, свежий tombstone и свежая _meta защищают; старый непривязанный блоб собирается", () => {
    const plan = planOrphanGc(
      base({
        listed: [
          { cloudPath: `${ROOT}/live.ts`, size: 10, modifiedIso: OLD },
          { cloudPath: `${ROOT}/fresh-tomb.ts`, size: 20, modifiedIso: OLD },
          { cloudPath: `${ROOT}/fresh-meta.ts`, size: 30, modifiedIso: OLD },
          { cloudPath: `${ROOT}/dead.ts`, size: 40, modifiedIso: OLD },
          { cloudPath: `${ROOT}/.vscodesync-workspace.json`, size: 1, modifiedIso: OLD },
          { cloudPath: `${ROOT}/_meta.json`, size: 1, modifiedIso: OLD },
        ],
        manifestFiles: [
          row({ path: "live.ts" }),
          row({ path: "fresh-tomb.ts", removedAt: FRESH }),
        ],
        metaFiles: { "fresh-meta.ts": { updatedAt: FRESH } },
      }),
    );
    expect(plan.orphanBlobs.map((o) => o.key)).toEqual(["dead.ts"]);
    expect(plan.totalBytes).toBe(40);
    expect(plan.skippedUndatable).toEqual([]);
  });

  it(".gz-суффикс срезается при сопоставлении с ключом", () => {
    const plan = planOrphanGc(
      base({
        listed: [{ cloudPath: `${ROOT}/live.ts.gz`, size: 5, modifiedIso: OLD }],
        manifestFiles: [row({ path: "live.ts" })],
      }),
    );
    expect(plan.orphanBlobs).toEqual([]);
  });

  it("объект без единого датирующего якоря не трогается и попадает в отчёт", () => {
    const plan = planOrphanGc(
      base({ listed: [{ cloudPath: `${ROOT}/mystery.bin`, size: 7 }] }),
    );
    expect(plan.orphanBlobs).toEqual([]);
    expect(plan.skippedUndatable).toEqual([`${ROOT}/mystery.bin`]);
  });

  it("старый tombstone датирует блоб даже без mtime листинга", () => {
    const plan = planOrphanGc(
      base({
        listed: [{ cloudPath: `${ROOT}/old-deleted.ts`, size: 8 }],
        manifestFiles: [row({ path: "old-deleted.ts", removedAt: OLD })],
      }),
    );
    expect(plan.orphanBlobs.map((o) => o.key)).toEqual(["old-deleted.ts"]);
  });
});

describe("planOrphanGc — история и цепочки", () => {
  it("история живого ключа и ключа-крошки (renamedFrom) не мусор; история мёртвого ключа собирается", () => {
    const plan = planOrphanGc(
      base({
        listed: [
          { cloudPath: `${ROOT}/.history/live.ts/2026-06-01T10-00-00_m.ts`, size: 1 },
          { cloudPath: `${ROOT}/.history/prev.ts/2026-06-01T10-00-00_m.ts`, size: 2 },
          { cloudPath: `${ROOT}/.history/dead/nested.ts/2026-06-01T10-00-00_m.ts`, size: 3 },
          { cloudPath: `${ROOT}/.snapshots/snap1.bin`, size: 99, modifiedIso: OLD },
        ],
        manifestFiles: [row({ path: "live.ts", renamedFrom: "prev.ts", renamedAt: FRESH })],
      }),
    );
    expect(plan.orphanHistoryFiles.map((o) => o.key)).toEqual(["dead/nested.ts"]);
    expect(plan.orphanHistoryFiles[0]?.size).toBe(3);
    // .snapshots living under its own retention is untouched.
    expect(plan.orphanBlobs).toEqual([]);
  });

  it("свежий снапшот мёртвого ключа (по штампу имени) переживает окно", () => {
    const plan = planOrphanGc(
      base({
        listed: [{ cloudPath: `${ROOT}/.history/dead.ts/2026-08-12T09-00-00_m.ts`, size: 1 }],
      }),
    );
    expect(plan.orphanHistoryFiles).toEqual([]);
  });
});

describe("planOrphanGc — _meta", () => {
  it("старая строка _meta без живой строки манифеста уходит в orphanMetaKeys", () => {
    const plan = planOrphanGc(
      base({
        metaFiles: {
          "gone.ts": { updatedAt: OLD },
          "live.ts": { updatedAt: OLD },
          "fresh.ts": { updatedAt: FRESH },
        },
        manifestFiles: [row({ path: "live.ts" })],
      }),
    );
    expect(plan.orphanMetaKeys).toEqual(["gone.ts"]);
  });
});
