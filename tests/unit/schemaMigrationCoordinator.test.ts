import { describe, expect, it, vi } from "vitest";
import {
  buildMigrationPlan,
  describeMigrationPlan,
  validateMigrationPlan,
  type MigrationStep,
} from "../../src/core/schemaMigrationCoordinator.js";

interface Ctx { ready: boolean; force?: boolean }

const stepReady: MigrationStep<Ctx> = {
  id: "step.ready",
  label: "Ready step",
  applies: (c) => c.ready,
  estimatedMs: 1000,
};
const stepForce: MigrationStep<Ctx> = {
  id: "step.force",
  label: "Force step",
  applies: () => true,
  validate: (c) => {
    if (!c.force) throw new Error("force flag required");
  },
  estimatedMs: 500,
};

describe("buildMigrationPlan", () => {
  it("filters out non-applicable steps", () => {
    const plan = buildMigrationPlan({
      fromSchema: 1, toSchema: 2,
      steps: [stepReady, stepForce],
      ctx: { ready: false },
    });
    expect(plan.applicableCount).toBe(1);
    expect(plan.steps[0]?.id).toBe("step.force");
  });

  it("sums ETA across applicable steps", () => {
    const plan = buildMigrationPlan({
      fromSchema: 1, toSchema: 2,
      steps: [stepReady, stepForce],
      ctx: { ready: true },
    });
    expect(plan.totalEtaMs).toBe(1500);
  });
});

describe("validateMigrationPlan", () => {
  it("returns ok when all validate hooks pass", () => {
    const plan = buildMigrationPlan({
      fromSchema: 1, toSchema: 2,
      steps: [stepReady, stepForce],
      ctx: { ready: true, force: true },
    });
    expect(validateMigrationPlan(plan, { ready: true, force: true }).ok).toBe(true);
  });

  it("reports first failing step", () => {
    const plan = buildMigrationPlan({
      fromSchema: 1, toSchema: 2,
      steps: [stepReady, stepForce],
      ctx: { ready: true, force: false },
    });
    const r = validateMigrationPlan(plan, { ready: true, force: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failedStepId).toBe("step.force");
      expect(r.reason).toContain("force");
    }
  });

  it("does not call applies during validation", () => {
    const spy = vi.fn().mockReturnValue(true);
    const step: MigrationStep<Ctx> = {
      id: "spy", label: "spy",
      applies: spy,
      validate: () => undefined,
    };
    const plan = buildMigrationPlan({ fromSchema: 1, toSchema: 2, steps: [step], ctx: { ready: true } });
    spy.mockClear();
    validateMigrationPlan(plan, { ready: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("describeMigrationPlan", () => {
  it("notes empty plan", () => {
    const plan = buildMigrationPlan({ fromSchema: 1, toSchema: 2, steps: [stepReady], ctx: { ready: false } });
    expect(describeMigrationPlan(plan)).toContain("ничего не требуется");
  });
  it("lists step labels", () => {
    const plan = buildMigrationPlan({ fromSchema: 1, toSchema: 2, steps: [stepReady], ctx: { ready: true } });
    expect(describeMigrationPlan(plan)).toContain("Ready step");
  });
});
