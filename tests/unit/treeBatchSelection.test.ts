/**
 * Multi-select batching for the Workspaces tree: which nodes a context-menu
 * command acts on. VS Code hands `(clickedItem, selection[])`, and the two
 * disagree more often than one would think — right-clicking outside the
 * selection is a normal gesture.
 *
 * The helper is exercised through its observable contract rather than
 * imported directly: it lives beside the commands, which need `vscode`.
 */
import { describe, expect, it } from "vitest";

type Node =
  | { kind: "file"; folderRoot: { fsPath: string }; localPath: string }
  | { kind: "fileFolder" }
  | { kind: "workspace" };

/** Mirror of `selectedFiles` in registerFileTreeContext.ts (warning aside). */
function selectedFiles(clicked: Node | undefined, selection: readonly Node[] | undefined): Node[] {
  const pool = selection && selection.length > 0 ? selection : clicked ? [clicked] : [];
  const files = pool.filter((e): e is Extract<Node, { kind: "file" }> => e.kind === "file");
  if (files.length === 0) return [];
  const root = files[0].folderRoot.fsPath;
  const sameRoot = files.filter((f) => f.folderRoot.fsPath === root);
  if (clicked?.kind === "file" && !sameRoot.some((f) => f.localPath === clicked.localPath)) {
    return [clicked];
  }
  return sameRoot;
}

const file = (localPath: string, root = "/proj"): Node => ({
  kind: "file",
  folderRoot: { fsPath: root },
  localPath,
});

describe("selectedFiles", () => {
  it("одиночный клик без выделения — один файл", () => {
    expect(selectedFiles(file("a.ts"), undefined)).toHaveLength(1);
    expect(selectedFiles(file("a.ts"), [])).toHaveLength(1);
  });

  it("выделение из нескольких файлов обрабатывается целиком", () => {
    const sel = [file("a.ts"), file("b.ts"), file("c.ts")];
    expect(selectedFiles(sel[0], sel).map((f) => (f as { localPath: string }).localPath)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("клик вне выделения побеждает — иначе действие уйдёт не туда", () => {
    const sel = [file("a.ts"), file("b.ts")];
    const out = selectedFiles(file("z.ts"), sel);
    expect(out).toHaveLength(1);
    expect((out[0] as { localPath: string }).localPath).toBe("z.ts");
  });

  it("папки и воркспейсы из выделения отбрасываются", () => {
    const sel: Node[] = [{ kind: "fileFolder" }, file("a.ts"), { kind: "workspace" }];
    expect(selectedFiles(sel[1], sel)).toHaveLength(1);
  });

  it("файлы чужого корня в батч не попадают", () => {
    const sel = [file("a.ts", "/proj"), file("b.ts", "/other")];
    const out = selectedFiles(sel[0], sel);
    expect(out).toHaveLength(1);
    expect((out[0] as { folderRoot: { fsPath: string } }).folderRoot.fsPath).toBe("/proj");
  });

  it("выделение без единого файла — пусто", () => {
    expect(selectedFiles({ kind: "fileFolder" }, [{ kind: "workspace" }])).toEqual([]);
    expect(selectedFiles(undefined, undefined)).toEqual([]);
  });
});
