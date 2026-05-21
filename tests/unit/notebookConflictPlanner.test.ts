import { describe, expect, it } from "vitest";
import {
  planNotebookConflict,
  tryParseNotebook,
  type NotebookDocument,
} from "../../src/core/notebookConflictPlanner.js";

const cell = (id: string, type: "code" | "markdown", src: string): NotebookDocument["cells"][number] => ({
  id, cell_type: type, source: src,
});

const nb = (...cells: NotebookDocument["cells"]): NotebookDocument => ({
  cells, metadata: {}, nbformat: 4, nbformat_minor: 5,
});

describe("tryParseNotebook", () => {
  it("returns null for invalid JSON", () => {
    expect(tryParseNotebook("not json")).toBeNull();
  });
  it("returns null when cells is missing", () => {
    expect(tryParseNotebook('{"metadata": {}}')).toBeNull();
  });
  it("parses a minimal notebook", () => {
    const out = tryParseNotebook('{"cells": [], "nbformat": 4}');
    expect(out).not.toBeNull();
    expect(out?.cells).toEqual([]);
  });
});

describe("planNotebookConflict", () => {
  it("identical local/remote → all keep-base", () => {
    const a = nb(cell("a", "code", "print(1)"));
    const p = planNotebookConflict(a, a, a);
    expect(p.effectivelySame).toBe(true);
    expect(p.cells[0]?.action).toBe("keep-base");
  });

  it("only local edited → keep-local", () => {
    const base = nb(cell("a", "code", "print(1)"));
    const local = nb(cell("a", "code", "print(2)"));
    const remote = nb(cell("a", "code", "print(1)"));
    const p = planNotebookConflict(base, local, remote);
    expect(p.cells[0]?.action).toBe("keep-local");
  });

  it("only remote edited → keep-remote", () => {
    const base = nb(cell("a", "code", "print(1)"));
    const local = nb(cell("a", "code", "print(1)"));
    const remote = nb(cell("a", "code", "print(3)"));
    const p = planNotebookConflict(base, local, remote);
    expect(p.cells[0]?.action).toBe("keep-remote");
  });

  it("both edited differently → conflict", () => {
    const base = nb(cell("a", "code", "print(1)"));
    const local = nb(cell("a", "code", "print(2)"));
    const remote = nb(cell("a", "code", "print(3)"));
    const p = planNotebookConflict(base, local, remote);
    expect(p.cells[0]?.action).toBe("conflict");
    expect(p.conflictCount).toBe(1);
  });

  it("cell inserted on local only → new-local", () => {
    const base = nb(cell("a", "code", "print(1)"));
    const local = nb(cell("a", "code", "print(1)"), cell("b", "code", "print(2)"));
    const remote = nb(cell("a", "code", "print(1)"));
    const p = planNotebookConflict(base, local, remote);
    expect(p.cells.find((c) => c.cellId === "b")?.action).toBe("new-local");
    expect(p.newOnLocal).toBe(1);
  });

  it("works without base (null)", () => {
    const local = nb(cell("a", "code", "print(1)"));
    const remote = nb(cell("a", "code", "print(2)"));
    const p = planNotebookConflict(null, local, remote);
    expect(p.conflictCount).toBe(1);
  });

  it("falls back to positional key when id missing", () => {
    const base = nb({ cell_type: "code", source: "x" });
    const local = nb({ cell_type: "code", source: "y" });
    const p = planNotebookConflict(base, local, base);
    expect(p.cells[0]?.action).toBe("keep-local");
  });
});
