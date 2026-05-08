/**
 * Phase 11 retention — pure planner for `vscodesync.snapshotRetentionDays`
 * and `vscodesync.maxSnapshotsPerWorkspace`. The setting was wired into
 * `package.json` and `settingsPanel.ts` but no enforcement existed in the
 * engine — this planner closes that gap.
 *
 * Two limits, applied independently:
 *   - **age**: anything with `createdAt` older than `retentionDays` is dropped.
 *   - **count**: when more than `maxPerWorkspace` user snapshots remain after
 *     the age sweep, the oldest user-tier snapshots are dropped until the
 *     count equals the cap. System-tier snapshots (`auto-` / `pre-migration-`
 *     prefixes) are never dropped by the count rule — they're caretaker
 *     records and must persist independently of user activity.
 *
 * No `vscode`, no IO. Caller iterates `delete` and runs
 * `deleteWorkspaceSnapshot(provider, workspaceId, name)`.
 */

import type { SnapshotInfo } from "./snapshotsEngine.js";

export interface SnapshotRetentionInput {
  snapshots: readonly SnapshotInfo[];
  /** From `vscodesync.snapshotRetentionDays` (1..3650). */
  retentionDays: number;
  /** From `vscodesync.maxSnapshotsPerWorkspace` (1..1000). Applied to user
   *  snapshots only. */
  maxPerWorkspace: number;
  /** Wall-clock used to evaluate age. Defaults to `Date.now()`. */
  nowMs?: number;
}

export type SnapshotRetentionReason = "age_exceeded" | "count_exceeded";

export interface SnapshotRetentionPlan {
  keep: SnapshotInfo[];
  delete: SnapshotInfo[];
  /** Per-name reason for deletion — useful for OutputChannel summaries. */
  reasons: Record<string, SnapshotRetentionReason>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function planSnapshotRetention(
  input: SnapshotRetentionInput,
): SnapshotRetentionPlan {
  if (input.retentionDays <= 0) {
    throw new Error("retentionDays must be > 0");
  }
  if (input.maxPerWorkspace <= 0) {
    throw new Error("maxPerWorkspace must be > 0");
  }
  const now = input.nowMs ?? Date.now();
  const cutoffMs = now - input.retentionDays * MS_PER_DAY;
  const reasons: Record<string, SnapshotRetentionReason> = {};
  const toDelete: SnapshotInfo[] = [];
  const surviving: SnapshotInfo[] = [];

  // Step 1 — age sweep.
  for (const s of input.snapshots) {
    const createdMs = Date.parse(s.meta.createdAt);
    if (Number.isFinite(createdMs) && createdMs < cutoffMs) {
      toDelete.push(s);
      reasons[s.name] = "age_exceeded";
    } else {
      surviving.push(s);
    }
  }

  // Step 2 — count cap on user snapshots only. Sort by createdAt asc and
  // drop the oldest until count == cap.
  const userSurviving = surviving
    .filter((s) => s.category === "user")
    .sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt));
  const overflow = Math.max(0, userSurviving.length - input.maxPerWorkspace);
  const dropForCount = userSurviving.slice(0, overflow);
  for (const s of dropForCount) {
    toDelete.push(s);
    reasons[s.name] = "count_exceeded";
  }

  const dropNames = new Set(toDelete.map((s) => s.name));
  const keep = surviving.filter((s) => !dropNames.has(s.name));
  return { keep, delete: toDelete, reasons };
}
