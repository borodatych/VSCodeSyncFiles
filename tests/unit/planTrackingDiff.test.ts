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

  it("файла нет на диске → adopt со статусом missing_local и пустым localHash", () => {
    // Раньше такие записи получали cloud-хэш в localHash и статус ok —
    // выглядели синхронизированными, и их никто никогда не тянул.
    const d = planTrackingDiff(
      makeInput({ manifestFiles: [{ path: "a.ts" }], existsLocally: () => false }),
    );
    expect(d.adopt[0]).toEqual({
      posixRel: "a.ts",
      wireGzip: false,
      localHash: "",
      syncStatus: "missing_local",
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

describe("planTrackingDiff — кэш идентичности (linkId)", () => {
  it("adopt несёт linkId строки манифеста — локальный кэш заполняется при адопции", () => {
    const d = planTrackingDiff(
      makeInput({ manifestFiles: [{ path: "a.ts", linkId: "aabbccdd00112233" }] }),
    );
    expect(d.adopt[0].linkId).toBe("aabbccdd00112233");
  });

  it("rename несёт linkId наследника", () => {
    const d = planTrackingDiff(
      makeInput({
        manifestFiles: [{ path: "b.ts", renamedFrom: "a.ts", linkId: "aabbccdd00112233" }],
        trackedPaths: ["a.ts"],
      }),
    );
    expect(d.rename[0]).toMatchObject({ from: "a.ts", to: "b.ts", linkId: "aabbccdd00112233" });
  });

  it("легаси-строка без linkId — поле отсутствует, не undefined-мусор", () => {
    const d = planTrackingDiff(makeInput({ manifestFiles: [{ path: "a.ts" }] }));
    expect("linkId" in d.adopt[0]).toBe(false);
  });
});

describe("planTrackingDiff — фаза linkId-реассоциации", () => {
  it("prune+adopt с общей идентичностью превращается в rename (офлайн дольше 30 дней, renamedFrom вычищен)", () => {
    const d = planTrackingDiff(
      makeInput({
        manifestFiles: [{ path: "lib/a.ts", linkId: "a".repeat(16) }],
        trackedPaths: ["src/a.ts"],
        trackedLinkIdOf: (key) => (key === "src/a.ts" ? "a".repeat(16) : undefined),
      }),
    );
    expect(d.rename).toEqual([
      { from: "src/a.ts", to: "lib/a.ts", wireGzip: false, localHash: "H", linkId: "a".repeat(16) },
    ]);
    expect(d.adopt).toEqual([]);
    expect(d.prune).toEqual([]);
  });

  it("цепочка a→b→c: renamedFrom указывает на b (не tracked), но идентичность находит a", () => {
    const d = planTrackingDiff(
      makeInput({
        manifestFiles: [{ path: "c.ts", renamedFrom: "b.ts", linkId: "c".repeat(16) }],
        trackedPaths: ["a.ts"],
        trackedLinkIdOf: (key) => (key === "a.ts" ? "c".repeat(16) : undefined),
      }),
    );
    expect(d.rename).toHaveLength(1);
    expect(d.rename[0]).toMatchObject({ from: "a.ts", to: "c.ts" });
    expect(d.prune).toEqual([]);
  });

  it("неоднозначная идентичность (дубль носителей) — пара НЕ строится", () => {
    const d = planTrackingDiff(
      makeInput({
        manifestFiles: [
          { path: "x/a.ts", linkId: "d".repeat(16) },
          { path: "y/a.ts", linkId: "d".repeat(16) },
        ],
        trackedPaths: ["src/a.ts"],
        trackedLinkIdOf: () => "d".repeat(16),
      }),
    );
    expect(d.rename).toEqual([]);
    expect(d.adopt).toHaveLength(2);
    expect(d.prune).toEqual(["src/a.ts"]);
  });

  it("renamedFrom-пара из фазы 1 не задваивается фазой 2", () => {
    const d = planTrackingDiff(
      makeInput({
        manifestFiles: [{ path: "b.ts", renamedFrom: "a.ts", linkId: "e".repeat(16) }],
        trackedPaths: ["a.ts"],
        trackedLinkIdOf: (key) => (key === "a.ts" ? "e".repeat(16) : undefined),
      }),
    );
    expect(d.rename).toHaveLength(1);
    expect(d.prune).toEqual([]);
  });
});
