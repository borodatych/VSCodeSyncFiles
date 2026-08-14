/**
 * The divergence list as a pure function (stage 3.5) — no provider, no disk.
 */
import { describe, expect, it } from "vitest";
import {
  buildDivergencePlan,
  describeDivergenceCounts,
  divergenceRowKey,
  filterDivergences,
  parseDivergenceRequest,
  selectableForBulk,
  summariseDivergences,
  type DivergenceRootInput,
} from "../../src/core/divergencePlan.js";
import type { ActiveWorkspaceEntry, TrackedFile, WorkspaceConfig } from "../../src/core/types.js";

function ws(workspaceId: string, note: string, extra: Partial<ActiveWorkspaceEntry> = {}): ActiveWorkspaceEntry {
  return { workspaceId, workspaceNote: note, ...extra };
}

function file(
  workspaceId: string,
  localPath: string,
  syncStatus: TrackedFile["syncStatus"],
  extra: Partial<TrackedFile> = {},
): TrackedFile {
  return {
    localPath,
    workspaceId,
    cloudPath: `VSCodeSyncFiles/${workspaceId}/${localPath}`,
    lastSync: "2026-07-31T00:00:00.000Z",
    localHash: "h",
    syncStatus,
    ...extra,
  };
}

function root(rootPath: string, cfg: Partial<WorkspaceConfig>): DivergenceRootInput {
  return { root: rootPath, cfg: { activeWorkspaces: [], files: [], ...cfg } };
}

describe("buildDivergencePlan", () => {
  it("оставляет только расходящиеся файлы, «ok» не показывается", () => {
    const groups = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("w1", "Первый")],
        files: [
          file("w1", "clean.ts", "ok"),
          file("w1", "mine.ts", "pending_push"),
          file("w1", "theirs.ts", "cloud_newer"),
          file("w1", "both.ts", "conflict"),
        ],
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((r) => r.posixRel)).toEqual(["both.ts", "mine.ts", "theirs.ts"]);
    expect(groups[0].rows.map((r) => r.direction)).toEqual(["conflict", "push", "pull"]);
  });

  it("файл без вычисленного статуса не считается расхождением", () => {
    const groups = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("w1", "Первый")],
        files: [file("w1", "unknown.ts", undefined)],
      }),
    ]);
    expect(groups).toEqual([]);
  });

  it("воркспейс без расхождений выпадает из списка", () => {
    const groups = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("w1", "Пустой"), ws("w2", "Второй")],
        files: [file("w2", "a.ts", "pending_push")],
      }),
    ]);
    expect(groups.map((g) => g.workspaceId)).toEqual(["w2"]);
  });

  it("собирает несколько корней в один список и сортирует по заметке", () => {
    const groups = buildDivergencePlan([
      root("/z", {
        activeWorkspaces: [ws("w2", "Яблоко")],
        files: [file("w2", "b.ts", "pending_push")],
      }),
      root("/a", {
        activeWorkspaces: [ws("w1", "Апельсин")],
        files: [file("w1", "a.ts", "cloud_newer")],
      }),
    ]);
    expect(groups.map((g) => g.workspaceNote)).toEqual(["Апельсин", "Яблоко"]);
    expect(groups.map((g) => g.root)).toEqual(["/a", "/z"]);
  });

  it("приостановленный воркспейс показывается, но помечен", () => {
    const groups = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("w1", "Пауза", { syncState: "suspended" })],
        files: [file("w1", "a.ts", "pending_push")],
      }),
    ]);
    expect(groups[0].suspended).toBe(true);
  });

  it("пустая заметка заменяется коротким id", () => {
    const groups = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("abcdef0123", "   ")],
        files: [file("abcdef0123", "a.ts", "pending_push")],
      }),
    ]);
    expect(groups[0].workspaceNote).toBe("abcdef01");
  });

  it("причина различает «нет локально» и «в облаке новее»", () => {
    const groups = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("w1", "W")],
        files: [
          file("w1", "absent.ts", "cloud_newer", { localHash: "" }),
          file("w1", "older.ts", "cloud_newer", { localHash: "h" }),
        ],
      }),
    ]);
    expect(groups[0].rows.find((r) => r.posixRel === "absent.ts")?.reason).toBe(
      "есть в облаке, нет локально",
    );
    expect(groups[0].rows.find((r) => r.posixRel === "older.ts")?.reason).toBe("в облаке новее");
  });

  it("переносит имя машины, держащей soft-lock", () => {
    const groups = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("w1", "W")],
        files: [file("w1", "a.ts", "cloud_newer", { editingByName: "MacBook" })],
      }),
    ]);
    expect(groups[0].rows[0].editingByName).toBe("MacBook");
  });
});

describe("filterDivergences", () => {
  const groups = buildDivergencePlan([
    root("/a", {
      activeWorkspaces: [ws("w1", "W")],
      files: [
        file("w1", "p.ts", "pending_push"),
        file("w1", "c.ts", "cloud_newer"),
        file("w1", "x.ts", "conflict"),
      ],
    }),
  ]);

  it("«все» отдаёт весь список", () => {
    expect(summariseDivergences(filterDivergences(groups, "all")).total).toBe(3);
  });

  it("чип оставляет одно направление", () => {
    const only = filterDivergences(groups, "pull");
    expect(only[0].rows.map((r) => r.posixRel)).toEqual(["c.ts"]);
  });

  it("группа без подходящих строк исчезает", () => {
    const groupsTwo = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("w1", "Только push"), ws("w2", "Только pull")],
        files: [file("w1", "p.ts", "pending_push"), file("w2", "c.ts", "cloud_newer")],
      }),
    ]);
    expect(filterDivergences(groupsTwo, "pull").map((g) => g.workspaceId)).toEqual(["w2"]);
  });

  it("не мутирует исходные группы", () => {
    filterDivergences(groups, "push");
    expect(summariseDivergences(groups).total).toBe(3);
  });
});

describe("summariseDivergences / describeDivergenceCounts", () => {
  it("считает по направлениям", () => {
    const counts = summariseDivergences(
      buildDivergencePlan([
        root("/a", {
          activeWorkspaces: [ws("w1", "W")],
          files: [
            file("w1", "p1.ts", "pending_push"),
            file("w1", "p2.ts", "pending_push"),
            file("w1", "c.ts", "cloud_newer"),
            file("w1", "x.ts", "conflict"),
          ],
        }),
      ]),
    );
    expect(counts).toEqual({ push: 2, pull: 1, conflict: 1, total: 4 });
    expect(describeDivergenceCounts(counts)).toBe("↑2 ↓1 ⚠1");
  });

  it("пустой список описывается словами, а не нулями", () => {
    expect(describeDivergenceCounts({ push: 0, pull: 0, conflict: 0, total: 0 })).toBe(
      "расхождений нет",
    );
  });

  it("строки приостановленного воркспейса не считаются", () => {
    const groups = buildDivergencePlan([
      root("/a", {
        activeWorkspaces: [ws("w1", "Активный"), ws("w2", "Пауза", { syncState: "suspended" })],
        files: [file("w1", "p.ts", "pending_push"), file("w2", "susp.ts", "pending_push")],
      }),
    ]);
    // Обе группы видны в панели...
    expect(groups).toHaveLength(2);
    // ...но счётчик (статус-бар, тост) знает только активную.
    expect(summariseDivergences(groups)).toEqual({ push: 1, pull: 0, conflict: 0, total: 1 });
  });

  it("нулевые направления не попадают в строку", () => {
    expect(describeDivergenceCounts({ push: 0, pull: 3, conflict: 0, total: 3 })).toBe("↓3");
  });
});

describe("selectableForBulk", () => {
  const groups = buildDivergencePlan([
    root("/a", {
      activeWorkspaces: [ws("w1", "Активный"), ws("w2", "Пауза", { syncState: "suspended" })],
      files: [
        file("w1", "p.ts", "pending_push"),
        file("w1", "x.ts", "conflict"),
        file("w2", "susp.ts", "pending_push"),
      ],
    }),
  ]);
  const allKeys = new Set(groups.flatMap((g) => g.rows.map((r) => divergenceRowKey(r))));

  it("берёт только выбранные строки нужного направления", () => {
    const rows = selectableForBulk(groups, "push", allKeys);
    expect(rows.map((r) => r.posixRel)).toEqual(["p.ts"]);
  });

  it("конфликты не попадают в массовые действия", () => {
    const rows = selectableForBulk(groups, "pull", allKeys);
    expect(rows).toEqual([]);
    expect(selectableForBulk(groups, "push", allKeys).some((r) => r.direction === "conflict")).toBe(
      false,
    );
  });

  it("приостановленный воркспейс исключён — движок всё равно откажет", () => {
    expect(selectableForBulk(groups, "push", allKeys).map((r) => r.workspaceId)).toEqual(["w1"]);
  });

  it("невыбранные строки не берутся", () => {
    expect(selectableForBulk(groups, "push", new Set())).toEqual([]);
  });
});

describe("divergenceRowKey", () => {
  it("различает одинаковые пути в разных корнях и воркспейсах", () => {
    const a = divergenceRowKey({ root: "/a", workspaceId: "w1", posixRel: "x.ts" });
    const b = divergenceRowKey({ root: "/b", workspaceId: "w1", posixRel: "x.ts" });
    const c = divergenceRowKey({ root: "/a", workspaceId: "w2", posixRel: "x.ts" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("разделитель не встречается в путях, поэтому склейку не подделать", () => {
    // With a printable separator these two would collapse into one key.
    const a = divergenceRowKey({ root: "/a b", workspaceId: "w1", posixRel: "x.ts" });
    const b = divergenceRowKey({ root: "/a", workspaceId: "b w1", posixRel: "x.ts" });
    expect(a).not.toBe(b);
  });
});

describe("parseDivergenceRequest — построчные действия", () => {
  it("row с направлением и ключом принимается", () => {
    expect(parseDivergenceRequest({ kind: "row", direction: "pull", key: "a\u0000b\u0000c.ts" })).toEqual({
      kind: "row",
      direction: "pull",
      key: "a\u0000b\u0000c.ts",
    });
    expect(parseDivergenceRequest({ kind: "row", direction: "push", key: "k" })).toEqual({
      kind: "row",
      direction: "push",
      key: "k",
    });
  });

  it("чужое направление и пустой ключ отбрасываются", () => {
    expect(parseDivergenceRequest({ kind: "row", direction: "conflict", key: "k" })).toBeNull();
    expect(parseDivergenceRequest({ kind: "row", direction: "pull", key: "" })).toBeNull();
    expect(parseDivergenceRequest({ kind: "row", direction: "pull" })).toBeNull();
    expect(parseDivergenceRequest({ kind: "row", key: "k" })).toBeNull();
  });
});

describe("parseDivergenceRequest — вебвью не доверяем", () => {
  it("принимает refresh", () => {
    expect(parseDivergenceRequest({ kind: "refresh" })).toEqual({ kind: "refresh" });
  });

  it("принимает bulk с массивом строковых ключей", () => {
    expect(parseDivergenceRequest({ kind: "bulk", direction: "push", keys: ["a", "b"] })).toEqual({
      kind: "bulk",
      direction: "push",
      keys: ["a", "b"],
    });
  });

  it("принимает compare и resolve с непустым ключом", () => {
    expect(parseDivergenceRequest({ kind: "compare", key: "k" })).toEqual({ kind: "compare", key: "k" });
    expect(parseDivergenceRequest({ kind: "resolve", key: "k" })).toEqual({ kind: "resolve", key: "k" });
  });

  it("отвергает неизвестный вид, в том числе попытку выполнить команду", () => {
    for (const raw of [
      { kind: "executeCommand", command: "workbench.action.terminal.new" },
      { command: "vscodesync.deleteWorkspaceFromCloud" },
      { kind: "eval", code: "1+1" },
      { kind: "" },
      {},
    ]) {
      expect(parseDivergenceRequest(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("отвергает не-объекты", () => {
    for (const raw of [null, undefined, 42, "refresh", ["refresh"], true]) {
      expect(parseDivergenceRequest(raw), String(raw)).toBeNull();
    }
  });

  it("отвергает bulk с чужим направлением или нестроковыми ключами", () => {
    expect(parseDivergenceRequest({ kind: "bulk", direction: "delete", keys: [] })).toBeNull();
    expect(parseDivergenceRequest({ kind: "bulk", direction: "push", keys: "a" })).toBeNull();
    expect(parseDivergenceRequest({ kind: "bulk", direction: "push", keys: ["a", 7] })).toBeNull();
    expect(parseDivergenceRequest({ kind: "bulk", direction: "push", keys: [{ toString: 1 }] })).toBeNull();
  });

  it("отвергает compare и resolve без ключа", () => {
    expect(parseDivergenceRequest({ kind: "compare" })).toBeNull();
    expect(parseDivergenceRequest({ kind: "compare", key: "" })).toBeNull();
    expect(parseDivergenceRequest({ kind: "resolve", key: 5 })).toBeNull();
  });

  it("лишние поля игнорируются, а не переносятся в результат", () => {
    expect(parseDivergenceRequest({ kind: "refresh", command: "rm -rf", args: ["x"] })).toEqual({
      kind: "refresh",
    });
  });
});
