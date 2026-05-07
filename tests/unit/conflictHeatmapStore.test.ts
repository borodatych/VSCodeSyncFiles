import { describe, it, expect } from "vitest";
import {
  appendConflictEntry,
  buildHotZones,
  emptyConflictLog,
  parseConflictLog,
} from "../../src/core/conflictHeatmapStore.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function entry(relPath: string, start: number, end: number, daysAgo = 0) {
  return {
    relPath,
    lineRangeStart: start,
    lineRangeEnd: end,
    at: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  };
}

describe("parseConflictLog", () => {
  it("returns empty for non-object", () => {
    expect(parseConflictLog(null).entries).toHaveLength(0);
    expect(parseConflictLog("nope").entries).toHaveLength(0);
  });
  it("filters bad entries", () => {
    const r = parseConflictLog({
      schema: 1,
      entries: [
        { relPath: "a.ts", lineRangeStart: 1, lineRangeEnd: 5, at: "2026-05-01T00:00:00Z" },
        { relPath: "b.ts", lineRangeStart: 10, lineRangeEnd: 5, at: "2026-05-01T00:00:00Z" }, // bad range
        { relPath: 42, lineRangeStart: 1, lineRangeEnd: 5, at: "x" }, // bad type
      ],
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.relPath).toBe("a.ts");
  });
});

describe("appendConflictEntry", () => {
  it("adds entry and prunes by retention", () => {
    let log = emptyConflictLog();
    log = appendConflictEntry(log, entry("a.ts", 1, 5, 200), NOW, 180);
    log = appendConflictEntry(log, entry("a.ts", 10, 15, 5), NOW, 180);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.lineRangeStart).toBe(10);
  });
  it("respects MAX_ENTRIES tail", () => {
    let log = emptyConflictLog();
    for (let i = 0; i < 5050; i++) {
      log = appendConflictEntry(log, entry("a.ts", i + 1, i + 2, 0), NOW, 365);
    }
    expect(log.entries.length).toBe(5000);
    expect(log.entries[0]?.lineRangeStart).toBe(51);
  });
});

describe("buildHotZones", () => {
  it("clusters overlapping ranges per file", () => {
    const log = {
      schema: 1 as const,
      entries: [
        entry("a.ts", 10, 20),
        entry("a.ts", 15, 25),
        entry("a.ts", 22, 30),
        entry("b.ts", 1, 5),
      ],
    };
    const zones = buildHotZones(log, 3);
    expect(zones).toHaveLength(1);
    expect(zones[0]?.relPath).toBe("a.ts");
    expect(zones[0]?.startLine).toBe(10);
    expect(zones[0]?.endLine).toBe(30);
    expect(zones[0]?.count).toBe(3);
  });
  it("does not cluster non-overlapping zones", () => {
    const log = {
      schema: 1 as const,
      entries: [
        entry("a.ts", 1, 5),
        entry("a.ts", 100, 105),
      ],
    };
    expect(buildHotZones(log, 1)).toHaveLength(2);
  });
  it("respects threshold", () => {
    const log = {
      schema: 1 as const,
      entries: [entry("a.ts", 1, 5), entry("a.ts", 3, 7)],
    };
    expect(buildHotZones(log, 3)).toHaveLength(0);
    expect(buildHotZones(log, 2)).toHaveLength(1);
  });
});
