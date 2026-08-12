/**
 * Canonical path editing — the planner. Composition is the load-bearing part:
 * three UX entry points funnel ordered edits here, and nested folder edits of
 * one session must collapse into ONE final mapping instead of fighting.
 */
import { describe, expect, it } from "vitest";
import {
  isValidCanonicalPath,
  planCanonicalRename,
  unnestedTarget,
} from "../../src/core/plan/planCanonicalRename.js";

const live = (path: string) => ({ path });
const dead = (path: string) => ({ path, removedAt: "t1" });

describe("isValidCanonicalPath", () => {
  it("отклоняет пустоту, абсолютные пути, точки и обратные слэши", () => {
    expect(isValidCanonicalPath("src/a.ts")).toBe(true);
    expect(isValidCanonicalPath("")).toBe(false);
    expect(isValidCanonicalPath("/src/a.ts")).toBe(false);
    expect(isValidCanonicalPath("src/")).toBe(false);
    expect(isValidCanonicalPath("src//a.ts")).toBe(false);
    expect(isValidCanonicalPath("src/../a.ts")).toBe(false);
    expect(isValidCanonicalPath("src/./a.ts")).toBe(false);
    expect(isValidCanonicalPath("src\\a.ts")).toBe(false);
  });
});

describe("unnestedTarget — подъём на уровень выше", () => {
  it("узел покидает родителя, имя сохраняется", () => {
    expect(unnestedTarget("a/b/c.ts")).toBe("a/c.ts");
    expect(unnestedTarget("src/SEMD272/jscore")).toBe("src/jscore");
  });

  it("родитель верхнего уровня — узел уходит в корень", () => {
    expect(unnestedTarget("b/c.ts")).toBe("c.ts");
  });

  it("узел в корне поднимать некуда", () => {
    expect(unnestedTarget("c.ts")).toBeNull();
    expect(unnestedTarget("")).toBeNull();
  });

  it("повторный подъём доводит до корня за глубину шагов", () => {
    let p: string | null = "a/b/c/d.ts";
    const seen: string[] = [];
    while (p !== null) {
      seen.push(p);
      p = unnestedTarget(p);
    }
    expect(seen).toEqual(["a/b/c/d.ts", "a/b/d.ts", "a/d.ts", "d.ts"]);
  });
});

describe("planCanonicalRename — композиция", () => {
  it("одиночный файл", () => {
    const p = planCanonicalRename([live("src/a.ts")], [{ scope: "file", from: "src/a.ts", to: "lib/a.ts" }]);
    expect(p.moves).toEqual([{ from: "src/a.ts", to: "lib/a.ts" }]);
    expect(p.problems).toEqual([]);
  });

  it("префикс разворачивается по живым строкам; tombstone не участвует", () => {
    const p = planCanonicalRename(
      [live("src/a.ts"), live("src/deep/b.ts"), dead("src/dead.ts"), live("other/c.ts")],
      [{ scope: "prefix", from: "src", to: "lib" }],
    );
    expect(p.moves).toEqual([
      { from: "src/a.ts", to: "lib/a.ts" },
      { from: "src/deep/b.ts", to: "lib/deep/b.ts" },
    ]);
    expect(p.prefixMoves).toEqual([{ from: "src", to: "lib" }]);
  });

  it("цепочка правок одной сессии сворачивается: rename папки, затем её подпапки", () => {
    // Владелец: «можно редактировать любой узел и все дочерние перестраивают
    // свои пути» — в том числе несколько правок подряд до подтверждения.
    const p = planCanonicalRename(
      [live("src/utils/a.ts"), live("src/main.ts")],
      [
        { scope: "prefix", from: "src", to: "lib" },
        { scope: "prefix", from: "lib/utils", to: "lib/helpers" },
      ],
    );
    expect(p.moves).toEqual([
      { from: "src/main.ts", to: "lib/main.ts" },
      { from: "src/utils/a.ts", to: "lib/helpers/a.ts" },
    ]);
    // prefixMoves выражены против ИСХОДНЫХ префиксов — их читает миграция
    // folderBindings, которая работает по исходному манифесту.
    expect(p.prefixMoves).toEqual(
      expect.arrayContaining([
        { from: "src", to: "lib" },
        { from: "src/utils", to: "lib/helpers" },
      ]),
    );
  });

  it("правка файла по уже переименованному имени (после prefix-хода) находит цель", () => {
    const p = planCanonicalRename(
      [live("src/a.ts")],
      [
        { scope: "prefix", from: "src", to: "lib" },
        { scope: "file", from: "lib/a.ts", to: "lib/renamed.ts" },
      ],
    );
    expect(p.moves).toEqual([{ from: "src/a.ts", to: "lib/renamed.ts" }]);
  });

  it("переезд, вернувший файл на исходный путь, исчезает из mapping", () => {
    const p = planCanonicalRename(
      [live("src/a.ts")],
      [
        { scope: "file", from: "src/a.ts", to: "tmp/a.ts" },
        { scope: "file", from: "tmp/a.ts", to: "src/a.ts" },
      ],
    );
    expect(p.moves).toEqual([]);
  });
});

describe("planCanonicalRename — проблемы и предупреждения", () => {
  it("невалидный путь, отсутствующий источник, дубль цели, коллизия", () => {
    const p = planCanonicalRename(
      [live("a.ts"), live("b.ts"), live("busy.ts")],
      [
        { scope: "file", from: "a.ts", to: "../evil.ts" },
        { scope: "file", from: "ghost.ts", to: "x.ts" },
        { scope: "file", from: "a.ts", to: "same.ts" },
        { scope: "file", from: "b.ts", to: "same.ts" },
        { scope: "file", from: "busy.ts", to: "b.ts" },
      ],
    );
    const kinds = p.problems.map((x) => x.kind).sort();
    expect(kinds).toEqual(["duplicate-target", "invalid-path", "missing-source"]);
    // busy.ts → b.ts легален: b.ts сам уезжает этим же батчем (same.ts).
    expect(p.moves).toEqual(
      expect.arrayContaining([{ from: "busy.ts", to: "b.ts" }]),
    );
  });

  it("коллизия с живой строкой, которую батч не уводит", () => {
    const p = planCanonicalRename(
      [live("a.ts"), live("busy.ts")],
      [{ scope: "file", from: "a.ts", to: "busy.ts" }],
    );
    expect(p.problems).toEqual([{ kind: "collision", move: { from: "a.ts", to: "busy.ts" } }]);
  });

  it("предупреждения: case-only, смена категории хэша, цель на tombstone", () => {
    const p = planCanonicalRename(
      [live("readme.md"), live("script.ts"), live("x.ts"), dead("parked.ts")],
      [
        { scope: "file", from: "readme.md", to: "README.md" },
        { scope: "file", from: "script.ts", to: "script.png" },
        { scope: "file", from: "x.ts", to: "parked.ts" },
      ],
    );
    const kinds = p.warnings.map((w) => w.kind).sort();
    expect(kinds).toEqual(["case-only", "hash-category-change", "tombstone-target"]);
    const cat = p.warnings.find((w) => w.kind === "hash-category-change");
    expect(cat).toMatchObject({ toBinary: true });
    expect(p.problems).toEqual([]);
  });
});
