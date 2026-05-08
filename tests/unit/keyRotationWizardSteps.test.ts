import { describe, expect, it } from "vitest";
import {
  planKeyRotationWizard,
  summariseKeyRotationWizard,
} from "../../src/core/keyRotationWizardSteps.js";
import {
  planKeyRotation,
  type RotationFileItem,
} from "../../src/core/keyRotationPlan.js";

function items(count: number, sizeEach = 1_000): RotationFileItem[] {
  return Array.from({ length: count }, (_v, i) => ({
    workspaceId: "ws1",
    relPath: `f${String(i)}.txt`,
    sizeBytes: sizeEach,
  }));
}

describe("planKeyRotationWizard — fallback branches", () => {
  it("inserts fallback_setup when no fallback exists and there is work to do", () => {
    const rotationPlan = planKeyRotation(items(3));
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: false,
      resumingPartial: false,
    });
    expect(r.steps).toEqual([
      "preflight",
      "confirm_scope",
      "fallback_setup",
      "batch_process",
      "verify",
      "done",
    ]);
    expect(r.fallbackDecision).toBe("fallback_required");
    expect(r.warnings).toContain("no_recovery_codes");
  });

  it("skips fallback_setup when fallback already configured", () => {
    const rotationPlan = planKeyRotation(items(3));
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: true,
      resumingPartial: false,
    });
    expect(r.steps).not.toContain("fallback_setup");
    expect(r.fallbackDecision).toBe("fallback_present");
    expect(r.warnings).not.toContain("no_recovery_codes");
  });

  it("returns 'fallback_skipped_no_op' when there are zero pending items", () => {
    const rotationPlan = planKeyRotation([]);
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: false,
      resumingPartial: false,
    });
    expect(r.fallbackDecision).toBe("fallback_skipped_no_op");
  });
});

describe("planKeyRotationWizard — verify branches", () => {
  it("includes verify after batch_process when items pending", () => {
    const rotationPlan = planKeyRotation(items(2));
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: true,
      resumingPartial: false,
    });
    expect(r.verifyDecision).toBe("verify_enabled");
    const i = r.steps.indexOf("batch_process");
    expect(r.steps[i + 1]).toBe("verify");
  });

  it("collapses to a no-op flow on empty input", () => {
    const rotationPlan = planKeyRotation([]);
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: true,
      resumingPartial: false,
    });
    expect(r.steps).toEqual(["preflight", "confirm_scope", "done"]);
    expect(r.verifyDecision).toBe("skip_no_items");
  });
});

describe("planKeyRotationWizard — warning surfacing", () => {
  it("flags very_large_dataset when totalBytes crosses threshold", () => {
    const rotationPlan = planKeyRotation(items(10, 1024 * 1024 * 200));
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: true,
      resumingPartial: false,
    });
    expect(r.warnings).toContain("very_large_dataset");
  });

  it("respects a caller-supplied largeDatasetThresholdBytes", () => {
    const rotationPlan = planKeyRotation(items(2, 1_000));
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: true,
      resumingPartial: false,
      largeDatasetThresholdBytes: 1_500,
    });
    expect(r.warnings).toContain("very_large_dataset");
  });

  it("flags resumed_partial_state when resumingPartial=true", () => {
    const rotationPlan = planKeyRotation(items(2));
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: true,
      resumingPartial: true,
    });
    expect(r.warnings).toContain("resumed_partial_state");
  });

  it("emits no warnings on the happy path (small + fallback + fresh)", () => {
    const rotationPlan = planKeyRotation(items(2));
    const r = planKeyRotationWizard({
      rotationPlan,
      hasFallback: true,
      resumingPartial: false,
    });
    expect(r.warnings).toEqual([]);
  });
});

describe("summariseKeyRotationWizard", () => {
  it("renders a title + description + detail row", () => {
    const rotationPlan = planKeyRotation(items(5));
    const wizard = planKeyRotationWizard({
      rotationPlan,
      hasFallback: true,
      resumingPartial: false,
    });
    const s = summariseKeyRotationWizard(wizard, rotationPlan);
    expect(s.title).toContain("5 files");
    expect(s.detail).toContain("preflight");
    expect(s.detail).toContain("done");
  });
});
