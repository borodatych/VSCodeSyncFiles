/**
 * v2.6.7 — sanitiseTagList tests (the only pure helper in the new module).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

const { sanitiseTagList } = await import("../../src/startup/restoreWorkspacesTreeFilters.js");

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
