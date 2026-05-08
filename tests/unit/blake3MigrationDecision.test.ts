import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRACE_PERIOD_MS,
  DEFAULT_RECOMMEND_THRESHOLD,
  planBlake3MigrationAction,
} from "../../src/core/blake3MigrationDecision.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

describe("planBlake3MigrationAction — current setting branches", () => {
  it("stays on sha256 when the setting is already sha256", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "sha256",
      dualWorkflowStartedMs: null,
      nowMs: NOW,
      completedRatio: 0,
    });
    expect(r).toEqual({
      action: "stay_sha256",
      reason: "setting_off",
      nextProbeMs: null,
    });
  });

  it("treats setting=blake3 as terminally safe (no probing required)", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "blake3",
      dualWorkflowStartedMs: NOW - 14 * DAY,
      nowMs: NOW,
      completedRatio: 1,
    });
    expect(r).toEqual({
      action: "safe_to_switch_now",
      reason: "setting_already_blake3",
      nextProbeMs: null,
    });
  });

  it("stays on sha256 when dual is set but globalState was wiped", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "dual",
      dualWorkflowStartedMs: null,
      nowMs: NOW,
      completedRatio: 0.5,
    });
    expect(r.action).toBe("stay_sha256");
    expect(r.reason).toBe("no_workflow_started");
  });
});

describe("planBlake3MigrationAction — grace window", () => {
  it("stays on dual while the grace period has not elapsed", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "dual",
      dualWorkflowStartedMs: NOW - 2 * DAY,
      nowMs: NOW,
      completedRatio: 1,
    });
    expect(r.action).toBe("stay_dual");
    expect(r.reason).toBe("grace_pending");
    expect(r.nextProbeMs).toBe(NOW - 2 * DAY + DEFAULT_GRACE_PERIOD_MS);
  });

  it("respects a caller-supplied gracePeriodMs", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "dual",
      dualWorkflowStartedMs: NOW - DAY,
      nowMs: NOW,
      completedRatio: 1,
      gracePeriodMs: 3 * DAY,
    });
    expect(r.action).toBe("stay_dual");
    expect(r.reason).toBe("grace_pending");
  });
});

describe("planBlake3MigrationAction — post-grace coverage classification", () => {
  it("returns safe_to_switch_now at 100% coverage", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "dual",
      dualWorkflowStartedMs: NOW - 8 * DAY,
      nowMs: NOW,
      completedRatio: 1,
    });
    expect(r.action).toBe("safe_to_switch_now");
    expect(r.reason).toBe("full_coverage");
  });

  it("recommends a switch when coverage crosses the default 95% threshold", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "dual",
      dualWorkflowStartedMs: NOW - 8 * DAY,
      nowMs: NOW,
      completedRatio: 0.97,
    });
    expect(r.action).toBe("recommend_switch");
    expect(r.reason).toBe("threshold_reached");
  });

  it("stays on dual when coverage is below the threshold", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "dual",
      dualWorkflowStartedMs: NOW - 8 * DAY,
      nowMs: NOW,
      completedRatio: 0.5,
    });
    expect(r.action).toBe("stay_dual");
    expect(r.reason).toBe("coverage_too_low");
  });

  it("respects a caller-supplied recommendThreshold (e.g. 0.5)", () => {
    const r = planBlake3MigrationAction({
      currentSetting: "dual",
      dualWorkflowStartedMs: NOW - 8 * DAY,
      nowMs: NOW,
      completedRatio: 0.6,
      recommendThreshold: 0.5,
    });
    expect(r.action).toBe("recommend_switch");
  });

  it("treats DEFAULT_RECOMMEND_THRESHOLD = 0.95 as documented", () => {
    expect(DEFAULT_RECOMMEND_THRESHOLD).toBe(0.95);
  });
});
