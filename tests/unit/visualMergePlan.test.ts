import { describe, expect, it } from "vitest";
import { applyHunkChoices, buildMergePlan } from "../../src/core/visualMergePlan.js";

describe("buildMergePlan — clean cases", () => {
  it("zero hunks for identical buffers", () => {
    const p = buildMergePlan(["a", "b", "c"], ["a", "b", "c"], ["a", "b", "c"]);
    expect(p.conflictCount).toBe(0);
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]?.kind).toBe("clean");
  });
});

describe("buildMergePlan — addition_local / addition_cloud", () => {
  it("local adds a line, cloud unchanged → addition_local", () => {
    const p = buildMergePlan(["a", "c"], ["a", "b", "c"], ["a", "c"]);
    expect(p.hunks.some((h) => h.kind === "addition_local")).toBe(true);
    expect(p.conflictCount).toBe(0);
  });

  it("cloud adds a line, local unchanged → addition_cloud", () => {
    const p = buildMergePlan(["a", "c"], ["a", "c"], ["a", "b", "c"]);
    expect(p.hunks.some((h) => h.kind === "addition_cloud")).toBe(true);
    expect(p.conflictCount).toBe(0);
  });
});

describe("buildMergePlan — conflict", () => {
  it("local and cloud both edit the same region differently → conflict", () => {
    const p = buildMergePlan(
      ["a", "x", "c"],
      ["a", "MINE", "c"],
      ["a", "THEIRS", "c"],
    );
    expect(p.conflictCount).toBe(1);
    const conflict = p.hunks.find((h) => h.kind === "conflict");
    expect(conflict?.local).toEqual(["MINE"]);
    expect(conflict?.cloud).toEqual(["THEIRS"]);
  });

  it("local and cloud agree on the same edit → clean (no conflict)", () => {
    const p = buildMergePlan(["a", "x", "c"], ["a", "Y", "c"], ["a", "Y", "c"]);
    expect(p.conflictCount).toBe(0);
  });
});

describe("applyHunkChoices", () => {
  const plan = buildMergePlan(
    ["a", "x", "c"],
    ["a", "MINE", "c"],
    ["a", "THEIRS", "c"],
  );

  it("default choice 'mine' picks local on conflicts", () => {
    const result = applyHunkChoices(plan.hunks, {});
    expect(result).toEqual(["a", "MINE", "c"]);
  });

  it("'theirs' picks cloud", () => {
    const choices: Partial<Record<number, "mine" | "theirs" | "merged">> = {};
    for (const h of plan.hunks) {
      if (h.kind === "conflict") choices[h.index] = "theirs";
    }
    const result = applyHunkChoices(plan.hunks, choices);
    expect(result).toEqual(["a", "THEIRS", "c"]);
  });

  it("'merged' uses customMerged when provided", () => {
    const conflict = plan.hunks.find((h) => h.kind === "conflict");
    if (!conflict) throw new Error("expected a conflict hunk");
    const result = applyHunkChoices(
      plan.hunks,
      { [conflict.index]: "merged" },
      { [conflict.index]: ["CUSTOM"] },
    );
    expect(result).toEqual(["a", "CUSTOM", "c"]);
  });

  it("clean hunks always emit base (choice ignored)", () => {
    const cleanPlan = buildMergePlan(["a", "b"], ["a", "b"], ["a", "b"]);
    const result = applyHunkChoices(cleanPlan.hunks, {});
    expect(result).toEqual(["a", "b"]);
  });
});
