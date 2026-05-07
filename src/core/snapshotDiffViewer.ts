/**
 * Snapshot Diff Viewer — skeleton.
 *
 * Goal: a webview that shows side-by-side diff between any two snapshots of
 * the same file (the .snapshots/{name}/ tree contains the historical
 * blobs). The pure helpers here describe the data shapes and produce the
 * inputs the future webview will consume.
 *
 * The webview itself (`renderDiff`) throws a sentinel so any caller that
 * tries to render before the implementation lands degrades to a clear
 * "needs work" message instead of silent failure.
 */

export class SnapshotDiffViewerNotImplementedError extends Error {
  constructor(message = "Snapshot Diff Viewer webview is not implemented yet") {
    super(message);
    this.name = "SnapshotDiffViewerNotImplementedError";
  }
}

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
    title: `Diff: ${input.relPath}`,
    leftLabel: fmt(input.left),
    rightLabel: fmt(input.right),
    identical: input.leftContent === input.rightContent,
  };
}

/** Sentinel: must be caught by callers to surface "needs work" UX. */
export function renderDiff(_input: SnapshotDiffInput): never {
  throw new SnapshotDiffViewerNotImplementedError();
}
