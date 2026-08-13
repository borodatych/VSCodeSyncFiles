/**
 * v2.6.7 — sanitiseTagList tests (the only pure helper in the new module),
 * plus the restore semantics of the tree's path space.
 */
import { describe, expect, it, vi } from "vitest";
import {
  restoreWorkspacesTreeFilters,
  sanitiseTagList,
} from "../../src/startup/restoreWorkspacesTreeFilters.js";
import { WORKSPACES_CANONICAL_MODE_KEY } from "../../src/ui/workspacesTreeFilterState.js";
import type { WorkspacesTreeProvider } from "../../src/ui/workspacesTree.js";

vi.mock("vscode", () => ({}));

describe("sanitiseTagList", () => {
  it("returns [] for non-array inputs", () => {
    expect(sanitiseTagList(null)).toEqual([]);
    expect(sanitiseTagList(undefined)).toEqual([]);
    expect(sanitiseTagList("string")).toEqual([]);
    expect(sanitiseTagList(42)).toEqual([]);
    expect(sanitiseTagList({ tags: ["a"] })).toEqual([]);
  });

  it("filters out non-string entries", () => {
    expect(sanitiseTagList(["a", 1, "b", null, "c"])).toEqual(["a", "b", "c"]);
  });

  it("preserves order of valid entries", () => {
    expect(sanitiseTagList(["z", "a", "m"])).toEqual(["z", "a", "m"]);
  });

  it("returns [] for an empty array", () => {
    expect(sanitiseTagList([])).toEqual([]);
  });
});

describe("restore пространства путей дерева", () => {
  function harness(stored: Record<string, unknown>) {
    const calls: boolean[] = [];
    const context = {
      globalState: { get: (k: string) => stored[k] },
    } as unknown as Parameters<typeof restoreWorkspacesTreeFilters>[0];
    const tree = {
      setNoteFilter: () => undefined,
      setTagFilters: () => undefined,
      setShowArchived: () => undefined,
      setCanonicalMode: (v: boolean) => calls.push(v),
    } as unknown as WorkspacesTreeProvider;
    restoreWorkspacesTreeFilters(context, tree);
    return calls;
  }

  it("без сохранённого значения — структура воркспейса (дефолт)", () => {
    expect(harness({})).toEqual([true]);
  });

  it("явный false — размещение этой машины", () => {
    expect(harness({ [WORKSPACES_CANONICAL_MODE_KEY]: false })).toEqual([false]);
  });

  it("сохранённый true переживает перезапуск", () => {
    expect(harness({ [WORKSPACES_CANONICAL_MODE_KEY]: true })).toEqual([true]);
  });
});
