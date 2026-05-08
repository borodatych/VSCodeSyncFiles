/**
 * Pure evaluator for the `vscodesync.longAbsenceThresholdDays` startup
 * notification. Currently the loop is inlined in `extension.ts` (~30 lines
 * around line 4684) and tightly coupled to vscode toast UX. The decision
 * — *which* active workspaces should trigger a long-absence warning given
 * their last-sync timestamps + threshold — is pure.
 *
 * Caller still owns the `WorkspaceConfigManager.load()` IO and the actual
 * `vscode.window.showWarningMessage(...)` interaction.
 *
 * No `vscode`. The evaluator emits at most one entry per workspace folder
 * (matching the existing "one notification per folder per session" rule),
 * picking the workspace with the staler last-sync.
 */

export interface LongAbsenceWorkspaceInput {
  /** Folder absolute path (used as a grouping key + for caller log lines). */
  folderPath: string;
  /** Active workspace ids tracked under this folder. */
  workspaces: readonly LongAbsenceWorkspaceCandidate[];
}

export interface LongAbsenceWorkspaceCandidate {
  workspaceId: string;
  workspaceNote: string;
  /** Most recent sync timestamp (ms epoch). `undefined` means "never synced",
   *  in which case the evaluator skips the entry — there's no useful
   *  baseline to compare. */
  lastSyncMs: number | undefined;
}

export interface LongAbsenceEvaluationInput {
  folders: readonly LongAbsenceWorkspaceInput[];
  /** From `vscodesync.longAbsenceThresholdDays`. Non-positive disables the check. */
  thresholdDays: number;
  /** Wall-clock used to compute "days since". Defaults to `Date.now()`. */
  nowMs?: number;
}

export interface LongAbsenceWarning {
  folderPath: string;
  workspaceId: string;
  workspaceNote: string;
  daysSinceLastSync: number;
  lastSyncMs: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function evaluateLongAbsence(
  input: LongAbsenceEvaluationInput,
): LongAbsenceWarning[] {
  if (input.thresholdDays <= 0) return [];
  const now = input.nowMs ?? Date.now();
  const cutoffMs = now - input.thresholdDays * MS_PER_DAY;
  const out: LongAbsenceWarning[] = [];

  for (const folder of input.folders) {
    let staleHit: LongAbsenceWarning | null = null;
    for (const ws of folder.workspaces) {
      if (ws.lastSyncMs === undefined) continue;
      if (ws.lastSyncMs >= cutoffMs) continue;
      const daysSince = Math.floor((now - ws.lastSyncMs) / MS_PER_DAY);
      if (staleHit === null || ws.lastSyncMs < staleHit.lastSyncMs) {
        staleHit = {
          folderPath: folder.folderPath,
          workspaceId: ws.workspaceId,
          workspaceNote: ws.workspaceNote,
          daysSinceLastSync: daysSince,
          lastSyncMs: ws.lastSyncMs,
        };
      }
    }
    if (staleHit !== null) {
      out.push(staleHit);
    }
  }
  return out;
}
