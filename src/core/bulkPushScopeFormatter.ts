/**
 * v3.H — pure QuickPick row formatter for the scope step in the bulk
 * push wizard. Companion to `bulkPushAiReviewFlow.ts` (which decides the
 * step sequence) and `bulkPushWizard.ts` (`planBulkPush` decides which
 * targets are eligible).
 *
 * No `vscode` import. Caller maps each row's `workspaceId` back to the
 * picked target.
 */

import type { BulkPushTarget } from "./bulkPushWizard.js";

export interface BulkPushScopeRow {
  workspaceId: string;
  label: string;
  description: string;
  detail: string;
  /** Whether the row should be pre-checked. Default: every target with
   * pendingFileCount > 0 is preselected so a single Enter pushes all. */
  picked: boolean;
}

export interface FormatBulkPushScopeOptions {
  /** Workspace ids to leave unchecked (e.g. ones explicitly skipped on a
   * previous wizard run). */
  initiallyUncheckedIds?: readonly string[];
  /** Optional formatter for pendingFileCount → label suffix. Defaults to
   * "(N pending)". */
  formatPendingCount?: (count: number) => string;
}

export function formatBulkPushScopeRows(
  targets: readonly BulkPushTarget[],
  options: FormatBulkPushScopeOptions = {},
): BulkPushScopeRow[] {
  const formatPending = options.formatPendingCount ?? defaultFormatPending;
  const unchecked = new Set(options.initiallyUncheckedIds ?? []);

  return targets.map<BulkPushScopeRow>((t) => ({
    workspaceId: t.workspaceId,
    label: t.workspaceNote.length > 0 ? t.workspaceNote : t.workspaceId,
    description: formatPending(t.pendingFileCount),
    detail: `id: ${t.workspaceId}`,
    picked: t.pendingFileCount > 0 && !unchecked.has(t.workspaceId),
  }));
}

function defaultFormatPending(count: number): string {
  if (count === 0) return "no pending changes";
  if (count === 1) return "1 pending file";
  return `${String(count)} pending files`;
}

/** Aggregate selected workspace ids back into a count summary suitable
 * for the confirm step's button label ("Push 12 files across 3
 * workspaces"). */
export interface BulkPushScopeSummary {
  selectedWorkspaceCount: number;
  totalSelectedFileCount: number;
  /** Total pending across all targets — drives "selecting N of M
   * workspaces" prompts. */
  availableWorkspaceCount: number;
}

export function summariseBulkPushScope(
  targets: readonly BulkPushTarget[],
  selectedWorkspaceIds: readonly string[],
): BulkPushScopeSummary {
  const sel = new Set(selectedWorkspaceIds);
  let totalSelectedFileCount = 0;
  let selectedCount = 0;
  for (const t of targets) {
    if (sel.has(t.workspaceId)) {
      totalSelectedFileCount += t.pendingFileCount;
      selectedCount += 1;
    }
  }
  return {
    selectedWorkspaceCount: selectedCount,
    totalSelectedFileCount,
    availableWorkspaceCount: targets.length,
  };
}
