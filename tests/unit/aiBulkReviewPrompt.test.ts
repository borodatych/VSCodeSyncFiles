import { describe, expect, it } from "vitest";
import {
  buildBulkReviewBatchPrompt,
  buildBulkReviewPrompt,
  parseBulkReviewVerdict,
  summariseBulkReview,
} from "../../src/core/aiBulkReviewPrompt.js";

describe("buildBulkReviewPrompt", () => {
  it("includes the path and the JSON-only instruction", () => {
    const out = buildBulkReviewPrompt({
      relPath: "src/auth.ts",
      localContent: "abc",
      cloudContent: "abd",
    });
    expect(out).toContain("Path: src/auth.ts");
    expect(out).toContain('{"riskScore"');
    expect(out).toContain("LOCAL VERSION");
    expect(out).toContain("CLOUD VERSION");
  });

  it("truncates oversized content with a marker", () => {
    const big = "x".repeat(8000);
    const out = buildBulkReviewPrompt({
      relPath: "p",
      localContent: big,
      cloudContent: "y",
    });
    expect(out).toContain("[truncated,");
  });
});

describe("buildBulkReviewBatchPrompt", () => {
  it("references each file with index and path", () => {
    const out = buildBulkReviewBatchPrompt([
      { relPath: "a.ts", localContent: "x", cloudContent: "y" },
      { relPath: "b.ts", localContent: "p", cloudContent: "q" },
    ]);
    expect(out).toContain("FILE #1: a.ts");
    expect(out).toContain("FILE #2: b.ts");
  });
});

describe("parseBulkReviewVerdict", () => {
  it("parses a valid JSON response", () => {
    const v = parseBulkReviewVerdict('{"riskScore": 0.4, "summary": "minor edits"}', "x.ts");
    expect(v).not.toBeNull();
    expect(v?.riskScore).toBe(0.4);
    expect(v?.summary).toBe("minor edits");
  });

  it("rejects non-JSON", () => {
    expect(parseBulkReviewVerdict("not json", "x.ts")).toBeNull();
  });

  it("rejects out-of-range riskScore", () => {
    expect(parseBulkReviewVerdict('{"riskScore": 1.5, "summary": "ok"}', "x.ts")).toBeNull();
    expect(parseBulkReviewVerdict('{"riskScore": -0.1, "summary": "ok"}', "x.ts")).toBeNull();
  });

  it("rejects oversized summary", () => {
    const long = "z".repeat(300);
    expect(parseBulkReviewVerdict(`{"riskScore": 0.1, "summary": "${long}"}`, "x.ts")).toBeNull();
  });

  it("rejects shape with missing fields", () => {
    expect(parseBulkReviewVerdict('{"foo": 1}', "x.ts")).toBeNull();
  });
});

describe("summariseBulkReview", () => {
  it("buckets by risk thresholds", () => {
    const r = summariseBulkReview([
      { relPath: "a", riskScore: 0.85, summary: "high" },
      { relPath: "b", riskScore: 0.4, summary: "medium" },
      { relPath: "c", riskScore: 0.05, summary: "low" },
    ]);
    expect(r.high).toHaveLength(1);
    expect(r.medium).toHaveLength(1);
    expect(r.low).toHaveLength(1);
    expect(r.needsAttention).toBe(true);
    expect(r.maxRisk).toBe(0.85);
  });

  it("returns zeros / no-attention for empty input", () => {
    const r = summariseBulkReview([]);
    expect(r.averageRisk).toBe(0);
    expect(r.maxRisk).toBe(0);
    expect(r.needsAttention).toBe(false);
  });
});
