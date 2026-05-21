/**
 * F6 — «Sync rewind» — pure planner.
 *
 * Skeleton: given the per-file history index (sorted by version desc)
 * and a target timestamp, pick the blob version that was current at
 * that moment. The actual rollback (download blob, write to disk,
 * update meta) lives in `SyncEngine.rewindFileTo(...)` — TODO, not in
 * this skeleton.
 *
 * Pure module — no provider calls, no filesystem.
 */

export interface RewindHistoryRow {
  /** Cloud path of the history blob, e.g. `<ws>/.history/<rel>/v17-...`. */
  cloudPath: string;
  /** Version number embedded in the meta row at the time of this version. */
  version: number;
  /** ISO timestamp when this version was written to history. */
  writtenAtIso: string;
  /** Hash digest of the body (canonical). */
  hash: string;
}

export interface RewindPlanInput {
  rows: RewindHistoryRow[];
  /** Target moment — pick the most recent row written at or before this. */
  targetMs: number;
}

export type RewindVerdict =
  | { kind: "match"; row: RewindHistoryRow }
  | { kind: "no_history" }
  | { kind: "target_too_old"; earliest: RewindHistoryRow }
  | { kind: "target_in_future"; latest: RewindHistoryRow };

export function planSyncRewind(input: RewindPlanInput): RewindVerdict {
  if (input.rows.length === 0) return { kind: "no_history" };
  const valid = input.rows
    .map((r) => ({ row: r, t: Date.parse(r.writtenAtIso) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  if (valid.length === 0) return { kind: "no_history" };
  // `valid.length === 0` is guarded above, so [0] and [length-1] are defined.
  const earliest = valid[0];
  const latest = valid[valid.length - 1];
  if (input.targetMs < earliest.t) return { kind: "target_too_old", earliest: earliest.row };
  if (input.targetMs >= latest.t) {
    // After (or at) the latest — pick latest.
    return { kind: "match", row: latest.row };
  }
  // Strictly between earliest and latest — pick the largest t ≤ target.
  let pick = earliest;
  for (const v of valid) {
    if (v.t <= input.targetMs) pick = v;
    else break;
  }
  return { kind: "match", row: pick.row };
}

/** Sentinel error: thrown by wiring layer when rewind is requested but
 *  the underlying engine method is not implemented yet. */
export class SyncRewindNotImplementedError extends Error {
  constructor() {
    super("SyncRewind: engine.rewindFileTo() not implemented yet");
    this.name = "SyncRewindNotImplementedError";
  }
}
