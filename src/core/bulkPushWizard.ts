/**
 * Bulk Push Wizard — skeleton.
 *
 * Goal: a multi-step wizard that pushes many workspaces at once with a
 * progress bar and per-workspace error reporting. Requires
 * `engine.pushAll(progressCb)` which does not exist yet.
 *
 * The pure helper plans the wizard steps so the future UI can render its
 * stepper without re-deriving the plan. The actual push throws a sentinel.
 */

export class BulkPushWizardNotImplementedError extends Error {
  constructor(message = "Bulk Push wizard backend (engine.pushAll) is not implemented yet") {
    super(message);
    this.name = "BulkPushWizardNotImplementedError";
  }
}

export interface BulkPushTarget {
  workspaceId: string;
  workspaceNote: string;
  pendingFileCount: number;
}

export interface BulkPushPlan {
  totalWorkspaces: number;
  totalPendingFiles: number;
  targets: BulkPushTarget[];
}

export function planBulkPush(targets: readonly BulkPushTarget[]): BulkPushPlan {
  const filtered = targets.filter((t) => t.pendingFileCount > 0);
  const totalPendingFiles = filtered.reduce((sum, t) => sum + t.pendingFileCount, 0);
  filtered.sort(
    (a, b) =>
      b.pendingFileCount - a.pendingFileCount ||
      a.workspaceNote.localeCompare(b.workspaceNote) ||
      a.workspaceId.localeCompare(b.workspaceId),
  );
  return {
    totalWorkspaces: filtered.length,
    totalPendingFiles,
    targets: filtered,
  };
}

export function runBulkPush(_plan: BulkPushPlan): never {
  throw new BulkPushWizardNotImplementedError();
}
