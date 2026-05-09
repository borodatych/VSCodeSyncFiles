/**
 * Unit tests for the SARIF v2.1.0 builder (v2.20.5).
 */
import { describe, it, expect } from "vitest";
import { buildConflictSarif } from "../../src/core/conflictHeatmapSarif.js";
import type { ConflictLogFile } from "../../src/core/conflictHeatmapStore.js";

const log: ConflictLogFile = {
  schema: 1,
  entries: [
    { relPath: "src/a.ts", lineRangeStart: 10, lineRangeEnd: 12, at: "2026-01-01T00:00:00Z" },
    { relPath: "src/a.ts", lineRangeStart: 10, lineRangeEnd: 12, at: "2026-01-02T00:00:00Z" },
    { relPath: "src/b.ts", lineRangeStart: 5, lineRangeEnd: 5, at: "2026-01-03T00:00:00Z" },
  ],
};

describe("buildConflictSarif", () => {
  it("produces a valid SARIF v2.1.0 envelope", () => {
    const sarif = buildConflictSarif(log);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0]?.tool.driver.name).toBe("VSCodeSync");
    expect(sarif.runs[0]?.tool.driver.rules).toHaveLength(1);
    expect(sarif.runs[0]?.tool.driver.rules[0]?.id).toBe("vscodesync/conflict");
  });

  it("emits one result per entry by default (no dedup)", () => {
    const sarif = buildConflictSarif(log);
    expect(sarif.runs[0]?.results).toHaveLength(3);
  });

  it("deduplicates same path + same range when requested", () => {
    const sarif = buildConflictSarif(log, { deduplicate: true });
    expect(sarif.runs[0]?.results).toHaveLength(2);
  });

  it("uses warning level + uriBaseId %SRCROOT% on every result", () => {
    const sarif = buildConflictSarif(log);
    for (const r of sarif.runs[0]?.results ?? []) {
      expect(r.level).toBe("warning");
      expect(r.locations[0]?.physicalLocation.artifactLocation.uriBaseId).toBe("%SRCROOT%");
    }
  });

  it("clamps line numbers to a sane minimum (1-based, end >= start)", () => {
    const weird: ConflictLogFile = {
      schema: 1,
      entries: [{ relPath: "x.ts", lineRangeStart: 0, lineRangeEnd: -5, at: "2026" }],
    };
    const sarif = buildConflictSarif(weird);
    const region = sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(1);
    expect(region.endLine).toBe(1);
  });

  it("accepts a custom message builder", () => {
    const sarif = buildConflictSarif(log, {
      buildMessage: (e) => `custom:${e.relPath}`,
    });
    expect(sarif.runs[0]?.results[0]?.message.text).toBe("custom:src/a.ts");
  });

  it("returns an empty result list for an empty log", () => {
    const sarif = buildConflictSarif({ schema: 1, entries: [] });
    expect(sarif.runs[0]?.results).toHaveLength(0);
  });
});
