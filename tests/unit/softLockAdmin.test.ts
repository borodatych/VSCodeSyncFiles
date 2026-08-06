import { describe, expect, it } from "vitest";
import { applyLockChange, findStaleLocks } from "../../src/core/softLockAdmin.js";
import type { CloudManifest, ManifestFile } from "../../src/core/cloudLayout.js";

const HOUR = 3600_000;
const NOW = Date.parse("2026-08-06T12:00:00.000Z");

function file(over: Partial<ManifestFile>): ManifestFile {
  return {
    path: "a.ts",
    addedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    hasSyncignoreMarkers: false,
    ...over,
  };
}

const manifest = (files: ManifestFile[]): CloudManifest =>
  ({ files } as unknown as CloudManifest);

describe("findStaleLocks", () => {
  it("свежий лок не стал stale, старый — стал", () => {
    const m = manifest([
      file({ path: "fresh.ts", editingBy: "m1", editingSince: new Date(NOW - HOUR).toISOString() }),
      file({ path: "old.ts", editingBy: "m2", editingSince: new Date(NOW - 10 * HOUR).toISOString() }),
    ]);
    const stale = findStaleLocks(m, 3 * HOUR, NOW);
    expect(stale.map((r) => r.posixRel)).toEqual(["old.ts"]);
    expect(stale[0]?.machineId).toBe("m2");
    expect(stale[0]?.ageMs).toBe(10 * HOUR);
  });

  it("строки без лока и с битой датой пропускаются", () => {
    const m = manifest([
      file({ path: "none.ts" }),
      file({ path: "broken.ts", editingBy: "m", editingSince: "не дата" }),
    ]);
    expect(findStaleLocks(m, 0, NOW)).toEqual([]);
  });

  it("tombstone не может быть «в редактировании»", () => {
    const m = manifest([
      file({
        path: "gone.ts",
        removedAt: "2026-02-01T00:00:00.000Z",
        editingBy: "m",
        editingSince: new Date(NOW - 99 * HOUR).toISOString(),
      }),
    ]);
    expect(findStaleLocks(m, HOUR, NOW)).toEqual([]);
  });
});

describe("applyLockChange", () => {
  it("ставит лок, не трогая version", () => {
    const files = [file({ version: 7 })];
    const out = applyLockChange(files, "a.ts", { machineId: "m1", sinceIso: "T" });
    expect(out?.[0]).toMatchObject({ editingBy: "m1", editingSince: "T", version: 7 });
  });

  it("снимает лок", () => {
    const files = [file({ editingBy: "m1", editingSince: "T" })];
    const out = applyLockChange(files, "a.ts", null);
    expect(out?.[0].editingBy).toBeUndefined();
    expect(out?.[0].editingSince).toBeUndefined();
  });

  it("null, когда ничего не меняется — вызывающий пропускает заливку", () => {
    const files = [file({ editingBy: "m1", editingSince: "T" })];
    expect(applyLockChange(files, "a.ts", { machineId: "m1", sinceIso: "T" })).toBeNull();
    expect(applyLockChange([file({})], "a.ts", null)).toBeNull();
  });

  it("null для неизвестного пути", () => {
    expect(applyLockChange([file({})], "nope.ts", null)).toBeNull();
  });

  it("исходный массив не мутируется", () => {
    const files = [file({})];
    applyLockChange(files, "a.ts", { machineId: "m1", sinceIso: "T" });
    expect(files[0].editingBy).toBeUndefined();
  });
});
