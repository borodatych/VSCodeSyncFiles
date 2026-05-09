/**
 * v2.20.2 — `planPrefetchHints` planner tests.
 */
import { describe, expect, it } from "vitest";
import {
  PrefetchApiNotAvailableError,
  planPrefetchHints,
} from "../../src/core/workspaceFsPrefetchHints.js";

const NOW = 1_700_000_000_000; // arbitrary fixed "now"
const DAY = 24 * 60 * 60 * 1000;

describe("planPrefetchHints", () => {
  it("orders by recency (lastOpened > lastModified)", () => {
    const plan = planPrefetchHints({
      nowMs: NOW,
      candidates: [
        { relPath: "old.ts", modifiedMs: NOW - 7 * DAY },
        { relPath: "recent.ts", modifiedMs: NOW - DAY, openedMs: NOW - 60_000 },
        { relPath: "moderate.ts", modifiedMs: NOW - 2 * DAY },
      ],
    });
    expect(plan.toPrefetch.slice(0, 1)).toEqual(["recent.ts"]);
  });

  it("respects maxCount", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      relPath: `f${String(i)}.ts`,
      modifiedMs: NOW - i * 60_000,
    }));
    const plan = planPrefetchHints({ nowMs: NOW, candidates, maxCount: 3 });
    expect(plan.toPrefetch).toHaveLength(3);
  });

  it("excludes files larger than maxSizeBytes", () => {
    const plan = planPrefetchHints({
      nowMs: NOW,
      candidates: [
        { relPath: "small.ts", modifiedMs: NOW, sizeBytes: 1024 },
        { relPath: "huge.bin", modifiedMs: NOW, sizeBytes: 50 * 1024 * 1024 },
      ],
      maxSizeBytes: 1024 * 1024,
    });
    expect(plan.toPrefetch).toContain("small.ts");
    expect(plan.toPrefetch).not.toContain("huge.bin");
    expect(plan.skippedTooLarge).toContain("huge.bin");
  });

  it("drops cold-and-unused files (no openedMs, modified > 30 days ago)", () => {
    const plan = planPrefetchHints({
      nowMs: NOW,
      candidates: [
        { relPath: "ancient.md", modifiedMs: NOW - 60 * DAY },
        { relPath: "recent.md", modifiedMs: NOW - 5 * DAY },
      ],
    });
    expect(plan.toPrefetch).not.toContain("ancient.md");
    expect(plan.skippedColdAndUnused).toContain("ancient.md");
    expect(plan.toPrefetch).toContain("recent.md");
  });

  it("keeps cold files that were recently opened anyway", () => {
    const plan = planPrefetchHints({
      nowMs: NOW,
      candidates: [
        { relPath: "ancient-but-pinned.md", modifiedMs: NOW - 60 * DAY, openedMs: NOW - 60_000 },
      ],
    });
    expect(plan.toPrefetch).toContain("ancient-but-pinned.md");
  });

  it("returns empty plan for empty input", () => {
    const plan = planPrefetchHints({ nowMs: NOW, candidates: [] });
    expect(plan.toPrefetch).toEqual([]);
    expect(plan.skippedTooLarge).toEqual([]);
    expect(plan.skippedColdAndUnused).toEqual([]);
  });
});

describe("PrefetchApiNotAvailableError", () => {
  it("has the documented code", () => {
    const e = new PrefetchApiNotAvailableError();
    expect(e.code).toBe("prefetch_api_not_available");
    expect(e.name).toBe("PrefetchApiNotAvailableError");
  });
});
