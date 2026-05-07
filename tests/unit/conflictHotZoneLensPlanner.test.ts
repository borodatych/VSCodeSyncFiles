import { describe, expect, it } from "vitest";
import {
  formatHotZoneLensTitle,
  planHotZoneLenses,
} from "../../src/ui/conflictHotZoneLensPlanner.js";
import type { HotZone } from "../../src/core/conflictHeatmapStore.js";

const zone = (over: Partial<HotZone>): HotZone => ({
  relPath: "src/a.ts",
  startLine: 10,
  endLine: 20,
  count: 5,
  ...over,
});

describe("planHotZoneLenses", () => {
  it("returns empty when document path is empty", () => {
    expect(planHotZoneLenses([zone({})], "", 100)).toEqual([]);
  });

  it("returns empty when line count is 0", () => {
    expect(planHotZoneLenses([zone({})], "src/a.ts", 0)).toEqual([]);
  });

  it("filters out zones that don't match the document", () => {
    const out = planHotZoneLenses(
      [zone({ relPath: "src/a.ts" }), zone({ relPath: "src/b.ts" })],
      "src/a.ts",
      100,
    );
    expect(out).toHaveLength(1);
  });

  it("ignores zones with non-positive count", () => {
    const out = planHotZoneLenses([zone({ count: 0 })], "src/a.ts", 100);
    expect(out).toEqual([]);
  });

  it("converts 1-based startLine to 0-based anchor and clamps to lineCount-1", () => {
    const out = planHotZoneLenses(
      [zone({ startLine: 1, endLine: 1 }), zone({ startLine: 999, endLine: 999 })],
      "src/a.ts",
      50,
    );
    expect(out[0]?.line).toBe(0);
    expect(out[1]?.line).toBe(49);
  });

  it("preserves the original zone start/end for the lens label", () => {
    const out = planHotZoneLenses([zone({ startLine: 10, endLine: 20 })], "src/a.ts", 100);
    expect(out[0]?.zoneStart).toBe(10);
    expect(out[0]?.zoneEnd).toBe(20);
  });

  it("sorts plans top-to-bottom", () => {
    const out = planHotZoneLenses(
      [
        zone({ startLine: 30 }),
        zone({ startLine: 10 }),
        zone({ startLine: 20 }),
      ],
      "src/a.ts",
      100,
    );
    expect(out.map((p) => p.line)).toEqual([9, 19, 29]);
  });
});

describe("formatHotZoneLensTitle", () => {
  it("collapses single-line span", () => {
    const t = formatHotZoneLensTitle({ line: 0, zoneStart: 5, zoneEnd: 5, count: 3 });
    expect(t).toContain("line 5");
    expect(t).toContain("3×");
  });

  it("uses range form for multi-line span", () => {
    const t = formatHotZoneLensTitle({ line: 0, zoneStart: 5, zoneEnd: 12, count: 7 });
    expect(t).toContain("lines 5–12");
    expect(t).toContain("7×");
  });
});
