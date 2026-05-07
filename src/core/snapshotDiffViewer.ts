/**
 * Snapshot Diff Viewer — pure planner for the side-by-side diff.
 *
 * The actual diff render is delegated to VS Code's built-in `vscode.diff`
 * command (see `src/ui/snapshotDiffCommand.ts`); this module only computes
 * labels and the identical-short-circuit flag.
 */

export interface SnapshotRef {
  workspaceId: string;
  snapshotName: string;
  createdAtMs: number;
}

export interface SnapshotDiffInput {
  relPath: string;
  left: SnapshotRef;
  right: SnapshotRef;
  leftContent: string;
  rightContent: string;
}

export interface SnapshotDiffPlan {
  title: string;
  leftLabel: string;
  rightLabel: string;
  /** True if both sides are byte-identical — the UI can short-circuit. */
  identical: boolean;
}

export function planSnapshotDiff(input: SnapshotDiffInput): SnapshotDiffPlan {
  const fmt = (r: SnapshotRef): string => `${r.snapshotName} · ${new Date(r.createdAtMs).toISOString()}`;
  return {
    title: `${input.relPath} (${input.left.snapshotName} ↔ ${input.right.snapshotName})`,
    leftLabel: fmt(input.left),
    rightLabel: fmt(input.right),
    identical: input.leftContent === input.rightContent,
  };
}

/**
 * Compute the union of file lists from two snapshot meta records — a file
 * needs to be in *either* snapshot to show up as a diff candidate (a file
 * present only in left appears as "deleted in right" and vice-versa).
 */
export function unionSnapshotFiles(leftFiles: readonly string[], rightFiles: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const f of leftFiles) seen.add(f);
  for (const f of rightFiles) seen.add(f);
  return [...seen].sort();
}
