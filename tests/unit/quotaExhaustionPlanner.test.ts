import { describe, expect, it } from "vitest";
import {
  formatBytesShort,
  planQuotaExhaustion,
  type TrackedFileWeight,
} from "../../src/core/quotaExhaustionPlanner.js";

const file = (rel: string, bytes: number, agoDays?: number): TrackedFileWeight => ({
  workspaceId: "ws-1",
  workspaceNote: "test",
  posixRel: rel,
  bytes,
  lastSyncIso: agoDays === undefined ? undefined : new Date(Date.now() - agoDays * 86_400_000).toISOString(),
});

describe("planQuotaExhaustion", () => {
  it("returns empty plan for empty input", () => {
    const p = planQuotaExhaustion([]);
    expect(p.topHeavy).toEqual([]);
    expect(p.totalBytes).toBe(0);
    expect(p.reclaimIfUntrackTop).toBe(0);
  });

  it("sorts by bytes desc and caps to topN", () => {
    const files = [
      file("a", 100),
      file("b", 1000),
      file("c", 50),
      file("d", 500),
    ];
    const p = planQuotaExhaustion(files, { topN: 2 });
    expect(p.topHeavy.map((f) => f.posixRel)).toEqual(["b", "d"]);
    expect(p.totalBytes).toBe(1650);
    expect(p.reclaimIfUntrackTop).toBe(1500);
  });

  it("buckets stale vs fresh by staleDays cutoff", () => {
    const nowMs = Date.now();
    const files = [
      file("old.ts", 1000, 60),
      file("new.ts", 800, 5),
    ];
    const p = planQuotaExhaustion(files, { topN: 5, staleDays: 30, nowMs });
    expect(p.staleTopBytes).toBe(1000);
    expect(p.freshTopBytes).toBe(800);
  });

  it("treats files without lastSyncIso as fresh", () => {
    const p = planQuotaExhaustion([file("x", 500)], { staleDays: 30 });
    expect(p.staleTopBytes).toBe(0);
    expect(p.freshTopBytes).toBe(500);
  });

  it("clamps topN to [1, 50]", () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`f${String(i)}`, 100 - i));
    expect(planQuotaExhaustion(files, { topN: 0 }).topHeavy).toHaveLength(1);
    expect(planQuotaExhaustion(files, { topN: 999 }).topHeavy).toHaveLength(10);
  });
});

describe("formatBytesShort", () => {
  it("formats common ranges", () => {
    expect(formatBytesShort(0)).toBe("0 B");
    expect(formatBytesShort(500)).toBe("500 B");
    expect(formatBytesShort(1500)).toBe("1.5 KB");
    expect(formatBytesShort(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytesShort(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });

  it("guards against bad input", () => {
    expect(formatBytesShort(-100)).toBe("0 B");
    expect(formatBytesShort(NaN)).toBe("0 B");
  });
});
