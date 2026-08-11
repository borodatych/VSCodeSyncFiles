/**
 * Link Bindings — pure bind planner (docs/v2/linkBindings.md). The engine is
 * an I/O shell around this; every guard and both written rows are decided
 * here.
 */
import { describe, expect, it } from "vitest";
import type { ManifestFile, MetaEntry } from "../../src/core/cloudLayout.js";
import type { TrackedFile } from "../../src/core/types.js";
import { planBindLocalFile, type BindPlanInput } from "../../src/core/plan/planBindLocalFile.js";

const row = (over: Partial<ManifestFile>): ManifestFile => ({
  path: "promed/api/user.php",
  addedAt: "t0",
  version: 3,
  hasSyncignoreMarkers: false,
  linkId: "aabbccddeeff0011",
  ...over,
});

const metaEntry = (over: Partial<MetaEntry> = {}): MetaEntry => ({
  hash: "H1",
  etag: "E1",
  version: 5,
  machineId: "M-other",
  updatedAt: "t1",
  ...over,
});

const baseInput = (over: Partial<BindPlanInput> = {}): BindPlanInput => ({
  workspaceId: "ws1",
  manifestKey: "promed/api/user.php",
  localPosixRel: "php/api/user.php",
  machineId: "M-home",
  trackedFiles: [],
  manifestFiles: [row({})],
  metaEntry: metaEntry(),
  localHash: "H1",
  nextVersion: 10,
  nowIso: "t9",
  replaceExisting: false,
  ...over,
});

describe("planBindLocalFile", () => {
  it("успех: строка получает bindings[me] и bump версии, tracked — manifestPath и кэш linkId", () => {
    const plan = planBindLocalFile(baseInput());
    if (!plan.ok) throw new Error(`unexpected rejection: ${plan.reason}`);
    expect(plan.contentMatches).toBe(true);
    expect(plan.updatedRow.version).toBe(10);
    expect(plan.updatedRow.bindings).toEqual({
      "M-home": { path: "php/api/user.php", boundAt: "t9" },
    });
    expect(plan.tracked).toMatchObject({
      localPath: "php/api/user.php",
      manifestPath: "promed/api/user.php",
      linkId: "aabbccddeeff0011",
      syncStatus: "ok",
      localHash: "H1",
    });
  });

  it("контент различается → cloud_newer и пустой localHash (данные двигает пользователь)", () => {
    const plan = planBindLocalFile(baseInput({ localHash: "H-DIFFERENT" }));
    if (!plan.ok) throw new Error("unexpected rejection");
    expect(plan.contentMatches).toBe(false);
    expect(plan.tracked.syncStatus).toBe("cloud_newer");
    expect(plan.tracked.localHash).toBe("");
  });

  it("bump версии не меньше prev.version + 1 даже при отстающем nextVersion", () => {
    const plan = planBindLocalFile(baseInput({ manifestFiles: [row({ version: 42 })], nextVersion: 10 }));
    if (!plan.ok) throw new Error("unexpected rejection");
    expect(plan.updatedRow.version).toBe(43);
  });

  it("привязка к каноническому пути всё равно ПИШЕТ ключ (отвязка ≠ удаление ключа)", () => {
    const plan = planBindLocalFile(
      baseInput({ localPosixRel: "promed/api/user.php" }),
    );
    if (!plan.ok) throw new Error("unexpected rejection");
    expect(plan.updatedRow.bindings?.["M-home"]?.path).toBe("promed/api/user.php");
    expect(plan.tracked.manifestPath).toBeUndefined();
  });

  it("чужие ключи bindings сохраняются", () => {
    const plan = planBindLocalFile(
      baseInput({
        manifestFiles: [row({ bindings: { "M-work": { path: "work/u.php", boundAt: "t2" } } })],
      }),
    );
    if (!plan.ok) throw new Error("unexpected rejection");
    expect(plan.updatedRow.bindings?.["M-work"]).toEqual({ path: "work/u.php", boundAt: "t2" });
  });

  it("анти-воскрешение: tombstone-строка отклоняется", () => {
    const plan = planBindLocalFile(baseInput({ manifestFiles: [row({ removedAt: "t5" })] }));
    expect(plan).toMatchObject({ ok: false, reason: "row_deleted" });
  });

  it("строки нет в манифесте → row_not_found", () => {
    const plan = planBindLocalFile(baseInput({ manifestFiles: [] }));
    expect(plan).toMatchObject({ ok: false, reason: "row_not_found" });
  });

  it("локальный путь уже трекается другой записью → отказ", () => {
    const tracked: TrackedFile = {
      localPath: "php/api/user.php",
      workspaceId: "ws1",
      cloudPath: "c",
      lastSync: "t",
      localHash: "x",
    };
    const plan = planBindLocalFile(baseInput({ trackedFiles: [tracked] }));
    expect(plan).toMatchObject({ ok: false, reason: "local_path_tracked" });
  });

  it("запись уже привязана к другому месту → отказ без replaceExisting, замена с ним", () => {
    const bound: TrackedFile = {
      localPath: "old/place.php",
      workspaceId: "ws1",
      cloudPath: "c",
      lastSync: "t",
      localHash: "x",
      manifestPath: "promed/api/user.php",
    };
    const refused = planBindLocalFile(baseInput({ trackedFiles: [bound] }));
    expect(refused).toMatchObject({ ok: false, reason: "already_bound", detail: "old/place.php" });
    const replaced = planBindLocalFile(baseInput({ trackedFiles: [bound], replaceExisting: true }));
    expect(replaced.ok).toBe(true);
  });

  it("повторная привязка того же файла к той же записи — идемпотентно разрешена", () => {
    const same: TrackedFile = {
      localPath: "php/api/user.php",
      workspaceId: "ws1",
      cloudPath: "c",
      lastSync: "t",
      localHash: "x",
      manifestPath: "promed/api/user.php",
    };
    const plan = planBindLocalFile(baseInput({ trackedFiles: [same] }));
    expect(plan.ok).toBe(true);
  });
});
