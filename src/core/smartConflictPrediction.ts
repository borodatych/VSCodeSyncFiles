/**
 * Smart Conflict Prediction — pure scorer.
 *
 * The full presence wire (per-path `editingBy[path]` propagated via
 * `_machines.json`) is still pending; the live UI uses the per-file
 * `editingBy` field that already lives in `cfg.files[]` and surfaces it via
 * `src/ui/smartConflictPredictionService.ts`.
 */

export interface OtherMachineEdit {
  machineName: string;
  relPath: string;
  startedAtMs: number;
  lastSeenMs: number;
}

export interface ConflictRiskInput {
  myMachineName: string;
  myEditingPath: string;
  others: readonly OtherMachineEdit[];
  nowMs: number;
}

export interface ConflictRiskResult {
  /** 0 = nobody else editing; 1 = active conflict almost certain. */
  score: number;
  /** Machines actively editing the same path right now. */
  activeOthers: string[];
}

const ACTIVE_WINDOW_MS = 90_000;

export function scoreConflictRisk(input: ConflictRiskInput): ConflictRiskResult {
  if (!input.myEditingPath || input.others.length === 0) {
    return { score: 0, activeOthers: [] };
  }
  const cutoff = input.nowMs - ACTIVE_WINDOW_MS;
  const activeOthers = input.others
    .filter(
      (o) =>
        o.relPath === input.myEditingPath &&
        o.machineName !== input.myMachineName &&
        o.lastSeenMs >= cutoff,
    )
    .map((o) => o.machineName);
  if (activeOthers.length === 0) return { score: 0, activeOthers: [] };
  // Score grows with the count of concurrent editors but plateaus quickly.
  const score = Math.min(0.4 + 0.3 * activeOthers.length, 1);
  return { score, activeOthers };
}

