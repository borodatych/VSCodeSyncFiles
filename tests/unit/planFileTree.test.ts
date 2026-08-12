/**
 * Folder tree for the workspaces panel (docs/v2/linkBindings.md). The rows are
 * the user's real case: 60+ files under a deep prefix, part of them bound to a
 * differently named cloud folder.
 */
import { describe, expect, it } from "vitest";
import { planFileTreeChildren, type FileTreeInputRow } from "../../src/core/plan/planFileTree.js";

const rows: FileTreeInputRow[] = [
  // Home layout: src/SEMD272/jscore/... bound to canonical jscore/...
  {
    localPath: "src/SEMD272/jscore/Forms4/Common/MorbusOnko/formStyle.js",
    manifestPath: "jscore/Forms4/Common/MorbusOnko/formStyle.js",
  },
  {
    localPath: "src/SEMD272/jscore/Forms4/Common/MorbusOnko/RhythmModal.js",
    manifestPath: "jscore/Forms4/Common/MorbusOnko/RhythmModal.js",
    syncStatus: "missing_local",
  },
  // php/ bound to canonical promed/
  { localPath: "src/SEMD272/php/modules/di_config.php", manifestPath: "promed/modules/di_config.php" },
  // Unbound file at the workspace root.
  { localPath: "README.md" },
];

describe("planFileTreeChildren", () => {
  it("корень: папки перед файлами, цепочка одиночных папок схлопнута", () => {
    const top = planFileTreeChildren(rows, "");
    expect(top.map((n) => n.name)).toEqual(["src/SEMD272", "README.md"]);
    expect(top[0]).toMatchObject({ kind: "folder", localPrefix: "src/SEMD272", fileCount: 3 });
    expect(top[1]).toMatchObject({ kind: "file", localPath: "README.md" });
  });

  it("бейдж канона ставится на папку, когда всё поддерево согласовано", () => {
    const level = planFileTreeChildren(rows, "src/SEMD272");
    const jscore = level.find((n) => n.name.startsWith("jscore"));
    const php = level.find((n) => n.name.startsWith("php"));
    // Узел схлопнут до MorbusOnko — канон показывается того же уровня, иначе
    // бейдж не совпадал бы с тем, что видит пользователь на этой строке.
    expect(jscore).toMatchObject({
      kind: "folder",
      name: "jscore/Forms4/Common/MorbusOnko",
      canonicalPrefix: "jscore/Forms4/Common/MorbusOnko",
    });
    // php ⇄ promed — имя папки другое, отображается один раз на папке.
    expect(php).toMatchObject({ kind: "folder", name: "php/modules", canonicalPrefix: "promed/modules" });
  });

  it("смешанное поддерево не получает бейджа — он соврал бы про часть файлов", () => {
    const mixed: FileTreeInputRow[] = [
      { localPath: "mix/a.ts", manifestPath: "canonA/a.ts" },
      { localPath: "mix/b.ts" },
    ];
    const top = planFileTreeChildren(mixed, "");
    expect(top[0]).toMatchObject({ kind: "folder", name: "mix" });
    expect((top[0] as { canonicalPrefix?: string }).canonicalPrefix).toBeUndefined();
  });

  it("папка считает файлы и отсутствующие на диске во всём поддереве", () => {
    const top = planFileTreeChildren(rows, "");
    expect(top[0]).toMatchObject({ fileCount: 3, missingCount: 1 });
  });

  it("схлопывание останавливается там, где появляется файл или ветвление", () => {
    const deep: FileTreeInputRow[] = [
      { localPath: "a/b/c/one.ts" },
      { localPath: "a/b/c/two.ts" },
      { localPath: "a/b/keep.ts" },
    ];
    // Файл в a/b держит уровень: схлопывается только «a/b», внутри — «c».
    const top = planFileTreeChildren(deep, "");
    expect(top.map((n) => n.name)).toEqual(["a/b"]);
    const inner = planFileTreeChildren(deep, "a/b");
    expect(inner.map((n) => n.name)).toEqual(["c", "keep.ts"]);
  });

  it("листовой уровень отдаёт файлы с полным локальным путём и статусом", () => {
    const leaf = planFileTreeChildren(rows, "src/SEMD272/jscore/Forms4/Common/MorbusOnko");
    expect(leaf.map((n) => n.name)).toEqual(["formStyle.js", "RhythmModal.js"]);
    expect(leaf[1]).toMatchObject({
      kind: "file",
      localPath: "src/SEMD272/jscore/Forms4/Common/MorbusOnko/RhythmModal.js",
      syncStatus: "missing_local",
    });
  });

  it("пустой список и путь без совпадений дают пустой уровень", () => {
    expect(planFileTreeChildren([], "")).toEqual([]);
    expect(planFileTreeChildren(rows, "nope")).toEqual([]);
  });
});
