import { describe, expect, it } from "vitest";
import {
  decideBulkPushConfirmation,
  formatVerdictsForQuickPick,
  planBulkPushAiReviewFlow,
} from "../../src/core/bulkPushAiReviewFlow.js";
import type {
  BulkReviewSummary,
  BulkReviewVerdict,
} from "../../src/core/aiBulkReviewPrompt.js";

describe("planBulkPushAiReviewFlow — decision branches", () => {
  it("includes the AI review step when enabled and the LM is available", () => {
    const r = planBulkPushAiReviewFlow({
      fileCount: 25,
      aiReviewEnabled: true,
      hasLm: true,
    });
    expect(r.steps).toEqual([
      "confirm_scope",
      "ai_batch_review",
      "review_summary",
      "confirm_apply",
    ]);
    expect(r.reviewDecision).toBe("review_enabled");
    expect(r.batchPlan).toEqual({ totalBatches: 3, perBatchFiles: 10, fileCount: 25 });
  });

  it("skips AI when the user opted out", () => {
    const r = planBulkPushAiReviewFlow({
      fileCount: 5,
      aiReviewEnabled: false,
      hasLm: true,
    });
    expect(r.steps).toEqual(["confirm_scope", "confirm_apply"]);
    expect(r.reviewDecision).toBe("skip_disabled");
    expect(r.batchPlan).toBeNull();
  });

  it("skips AI when the LM is unavailable even if enabled", () => {
    const r = planBulkPushAiReviewFlow({
      fileCount: 5,
      aiReviewEnabled: true,
      hasLm: false,
    });
    expect(r.reviewDecision).toBe("skip_no_lm");
  });

  it("skips AI on an empty file list", () => {
    const r = planBulkPushAiReviewFlow({
      fileCount: 0,
      aiReviewEnabled: true,
      hasLm: true,
    });
    expect(r.reviewDecision).toBe("skip_no_files");
    expect(r.steps).toEqual(["confirm_scope", "confirm_apply"]);
  });

  it("respects a caller-supplied batchSize", () => {
    const r = planBulkPushAiReviewFlow({
      fileCount: 17,
      aiReviewEnabled: true,
      hasLm: true,
      batchSize: 5,
    });
    expect(r.batchPlan).toEqual({ totalBatches: 4, perBatchFiles: 5, fileCount: 17 });
  });

  it("clamps a non-positive batchSize to 1", () => {
    const r = planBulkPushAiReviewFlow({
      fileCount: 3,
      aiReviewEnabled: true,
      hasLm: true,
      batchSize: 0,
    });
    expect(r.batchPlan?.perBatchFiles).toBe(1);
    expect(r.batchPlan?.totalBatches).toBe(3);
  });
});

describe("formatVerdictsForQuickPick", () => {
  function v(rel: string, risk: number, summary = `summary for ${rel}`): BulkReviewVerdict {
    return { relPath: rel, riskScore: risk, summary };
  }

  it("renders label/description/detail in highest-risk-first order", () => {
    const items = formatVerdictsForQuickPick([
      v("low.ts", 0.1),
      v("high.ts", 0.9),
      v("mid.ts", 0.5),
    ]);
    expect(items.map((i) => i.label)).toEqual(["high.ts", "mid.ts", "low.ts"]);
  });

  it("pre-selects files below the high-risk threshold", () => {
    const items = formatVerdictsForQuickPick([
      v("safe.ts", 0.1),
      v("risky.ts", 0.85),
    ]);
    const safe = items.find((i) => i.label === "safe.ts");
    const risky = items.find((i) => i.label === "risky.ts");
    expect(safe?.picked).toBe(true);
    expect(risky?.picked).toBe(false);
  });

  it("formats riskScore to two decimal places in the description", () => {
    const items = formatVerdictsForQuickPick([v("a.ts", 0.123456)]);
    expect(items[0].description).toBe("risk 0.12");
  });
});

describe("decideBulkPushConfirmation — escalation ladder", () => {
  function summary(maxRisk: number, needsAttention: boolean): BulkReviewSummary {
    return {
      averageRisk: maxRisk,
      maxRisk,
      high: needsAttention ? [{ relPath: "h", riskScore: maxRisk, summary: "" }] : [],
      medium: [],
      low: [],
      needsAttention,
    };
  }

  it("auto-applies when there are zero files (no-op)", () => {
    expect(decideBulkPushConfirmation(null, 0)).toEqual({
      level: "auto_apply",
      reason: "no_files",
    });
  });

  it("falls back to plain 'confirm' when no AI review ran", () => {
    const r = decideBulkPushConfirmation(null, 5);
    expect(r.level).toBe("confirm");
    expect(r.reason).toBe("no_review");
  });

  it("escalates to explicit_confirm when needsAttention is set", () => {
    const r = decideBulkPushConfirmation(summary(0.95, true), 5);
    expect(r.level).toBe("explicit_confirm");
    expect(r.reason).toBe("high_risk_present");
  });

  it("downgrades to plain confirm for medium-risk-only", () => {
    const r = decideBulkPushConfirmation(summary(0.5, false), 5);
    expect(r.level).toBe("confirm");
    expect(r.reason).toBe("medium_risk_present");
  });

  it("uses 'all_low_risk' reason when maxRisk is below 0.3", () => {
    const r = decideBulkPushConfirmation(summary(0.1, false), 5);
    expect(r.level).toBe("confirm");
    expect(r.reason).toBe("all_low_risk");
  });
});
