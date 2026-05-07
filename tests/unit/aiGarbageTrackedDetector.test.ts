import { describe, it, expect } from "vitest";
import {
  buildGarbagePrompt,
  rankGarbageCandidates,
  scoreSample,
  suggestIgnorePatterns,
} from "../../src/core/aiGarbageTrackedDetector.js";

describe("scoreSample", () => {
  it("flags node_modules highly", () => {
    const r = scoreSample({ path: "src/node_modules/x/index.js", pushCount: 1 });
    expect(r.score).toBeGreaterThanOrEqual(1);
    expect(r.reasons).toContain("node_modules");
  });
  it("ignores plain source", () => {
    const r = scoreSample({ path: "src/index.ts", pushCount: 1 });
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });
  it("bumps for high churn", () => {
    const r = scoreSample({ path: "build/x.js", pushCount: 50 });
    expect(r.reasons).toContain("high churn (50 pushes)");
  });
  it("bumps for large file", () => {
    const r = scoreSample({ path: "logs/big.log", pushCount: 1, sizeBytes: 10_000_000 });
    expect(r.reasons.some((x) => x.startsWith("large"))).toBe(true);
  });
});

describe("rankGarbageCandidates", () => {
  it("sorts by score desc and respects minScore", () => {
    const r = rankGarbageCandidates([
      { path: "src/a.ts", pushCount: 1 },
      { path: ".cache/x", pushCount: 1 },
      { path: "node_modules/y", pushCount: 1 },
    ]);
    expect(r[0]?.path).toBe("node_modules/y");
    expect(r.find((c) => c.path === "src/a.ts")).toBeUndefined();
  });
  it("respects topN", () => {
    const r = rankGarbageCandidates(
      Array.from({ length: 5 }, (_v, i) => ({
        path: `node_modules/${String(i)}`,
        pushCount: 1,
      })),
      0.5,
      2,
    );
    expect(r.length).toBe(2);
  });
});

describe("suggestIgnorePatterns", () => {
  it("collapses paths into glob patterns", () => {
    const cands = rankGarbageCandidates([
      { path: "node_modules/a", pushCount: 1 },
      { path: "node_modules/b", pushCount: 1 },
      { path: "logs/x.log", pushCount: 1 },
      { path: ".DS_Store", pushCount: 1 },
    ]);
    const patterns = suggestIgnorePatterns(cands);
    expect(patterns).toContain("node_modules/");
    expect(patterns).toContain("*.log");
    expect(patterns).toContain(".DS_Store");
  });
});

describe("buildGarbagePrompt", () => {
  it("contains every candidate", () => {
    const p = buildGarbagePrompt([
      { path: "node_modules/x", score: 1, reasons: ["node_modules"] },
      { path: "logs/a.log", score: 0.6, reasons: ["log file"] },
    ]);
    expect(p).toMatch(/node_modules\/x/);
    expect(p).toMatch(/logs\/a\.log/);
  });
});
