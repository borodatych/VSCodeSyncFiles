/**
 * v0.17 N17 — pure coordinator for end-to-end schema migrations.
 *
 * When the manifest schema bumps (e.g. v1 → v2 for BLAKE3 / multi-DEK),
 * we need a coordinated plan: pre-flight which machines are ready,
 * compute the migration step list, validate post-state. This module is
 * the planner; the engine performs the actual IO.
 *
 * Migrations are described declaratively as ordered "steps" with a
 * `validate` hook before running and an `applies` hook checking whether
 * the step is still needed (idempotent re-run).
 */

export interface MigrationStep<C = unknown> {
  /** Stable id for resume / dedup. */
  id: string;
  /** Human label for progress UI. */
  label: string;
  /** Returns true if this step has work to do given current context. */
  applies: (ctx: C) => boolean;
  /** Pre-flight check; throw to abort the whole plan. */
  validate?: (ctx: C) => void;
  /** Estimated duration in ms (for ETA). */
  estimatedMs?: number;
}

export interface MigrationPlan<C = unknown> {
  fromSchema: number;
  toSchema: number;
  steps: MigrationStep<C>[];
  /** Total ETA when all applicable steps are summed. */
  totalEtaMs: number;
  /** Number of steps that report `applies=true`. */
  applicableCount: number;
}

export interface BuildMigrationPlanOptions<C> {
  fromSchema: number;
  toSchema: number;
  steps: readonly MigrationStep<C>[];
  ctx: C;
}

export function buildMigrationPlan<C>(
  opts: BuildMigrationPlanOptions<C>,
): MigrationPlan<C> {
  const applicable = opts.steps.filter((s) => s.applies(opts.ctx));
  const totalEtaMs = applicable.reduce(
    (sum, s) => sum + (s.estimatedMs ?? 0),
    0,
  );
  return {
    fromSchema: opts.fromSchema,
    toSchema: opts.toSchema,
    steps: applicable.slice(),
    totalEtaMs,
    applicableCount: applicable.length,
  };
}

/** Pre-flight: run every applicable step's `validate` hook. Collect errors. */
export function validateMigrationPlan<C>(
  plan: MigrationPlan<C>,
  ctx: C,
): { ok: true } | { ok: false; failedStepId: string; reason: string } {
  for (const step of plan.steps) {
    if (!step.validate) continue;
    try {
      step.validate(ctx);
    } catch (e) {
      return {
        ok: false,
        failedStepId: step.id,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { ok: true };
}

/** Format the plan for the confirmation modal. */
export function describeMigrationPlan<C>(plan: MigrationPlan<C>): string {
  if (plan.applicableCount === 0) {
    return `Schema ${String(plan.fromSchema)} → ${String(plan.toSchema)}: ничего не требуется.`;
  }
  const etaSec = Math.ceil(plan.totalEtaMs / 1000);
  const lines: string[] = [];
  lines.push(`Schema migration ${String(plan.fromSchema)} → ${String(plan.toSchema)}:`);
  lines.push(`  ${String(plan.applicableCount)} шагов, оценочно ${String(etaSec)}с.`);
  for (const s of plan.steps) {
    lines.push(`  • ${s.label}`);
  }
  return lines.join("\n");
}
