import { describe, expect, it } from "vitest";
import {
  planTrackingDiff,
  type TrackingDiffInput,
} from "../../src/core/plan/planTrackingDiff.js";

function makeInput(over: Partial<TrackingDiffInput> = {}): TrackingDiffInput {
  return {
    workspaceId: "ws",
    manifestFiles: [],
    trackedPaths: [],
    metaHashFor: () => "H",
    wireGzipFor: () => false,
    existsLocally: () => true,
    ...over,
  };
}

describe("planTrackingDiff", () => {
  it("файл манифеста, которого нет локально в списке → adopt", () => {
    const d = planTrackingDiff(
      makeInput({ manifestFiles: [{ path: "a.ts" }], trackedPaths: [] }),
    );
    expect(d.adopt).toEqual([
      { posixRel: "a.ts", wireGzip: false, localHash: "H", syncStatus: "ok" },
    ]);
    expect(d.prune).toEqual([]);
  });

  it("файла нет на диске → adopt со статусом cloud_newer и пустым localHash", () => {
    // Раньше такие записи получали cloud-хэш в localHash и статус ok —
    // выглядели синхронизированными, и их никто никогда не тянул.
    const d = planTrackingDiff(
      makeInput({ manifestFiles: [{ path: "a.ts" }], existsLocally: () => false }),
    );
    expect(d.adopt[0]).toEqual({
      posixRel: "a.ts",
      wireGzip: false,
      localHash: "",
      syncStatus: "cloud_newer",
    });
  });

  it("tombstone в манифесте → prune", () => {
    const d = planTrackingDiff(
      makeInput({
        manifestFiles: [{ path: "a.ts", removedAt: "2026-01-01T00:00:00Z" }],
        trackedPaths: ["a.ts"],
      }),
    );
    expect(d.prune).toEqual(["a.ts"]);
    expect(d.adopt).toEqual([]);
  });

  it("переименование двигает запись, а не дублирует её", () => {
    const d = planTrackingDiff(
      makeInput({
        manifestFiles: [{ path: "new.ts", renamedFrom: "old.ts" }],
        trackedPaths: ["old.ts"],
      }),
    );
    expect(d.rename).toEqual([{ from: "old.ts", to: "new.ts", wireGzip: false, localHash: "H" }]);
    expect(d.adopt).toEqual([]);
    // Старое имя ушло не в prune: запись переезжает.
    expect(d.prune).toEqual([]);
  });

  it("renamedFrom на неизвестный путь → обычный adopt", () => {
    const d = planTrackingDiff(
      makeInput({
        manifestFiles: [{ path: "new.ts", renamedFrom: "never-tracked.ts" }],
        trackedPaths: [],
      }),
    );
    expect(d.rename).toEqual([]);
    expect(d.adopt.map((a) => a.posixRel)).toEqual(["new.ts"]);
  });

  it("wireGzip из меты попадает в план (иначе путь блоба без .gz)", () => {
    const d = planTrackingDiff(
      makeInput({ manifestFiles: [{ path: "a.ts" }], wireGzipFor: () => true }),
    );
    expect(d.adopt[0]?.wireGzip).toBe(true);
  });

  it("совпадающий состав → пустой план", () => {
    const d = planTrackingDiff(
      makeInput({ manifestFiles: [{ path: "a.ts" }], trackedPaths: ["a.ts"] }),
    );
    expect(d).toEqual({ adopt: [], rename: [], prune: [] });
  });
});
