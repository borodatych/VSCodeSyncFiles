/**
 * v3.I — pure validator for the "restore-test" path: given a tentative
 * restore-from-secondary plan (manifest entries + meta entries +
 * snapshot index), report whether the result would be self-consistent.
 *
 * Distinct from `backupVerifyPlanner` (primary vs secondary diff) —
 * this module checks that one snapshot of state is internally usable.
 *
 * No `vscode` import. No provider call.
 */

export interface RestoreManifestEntry {
  relPath: string;
  hash: string;
  /** ms timestamp of when this entry was last written. */
  updatedAtMs: number;
}

export interface RestoreMetaEntry {
  relPath: string;
  hash: string;
  /** ms when the meta entry was last updated. Some providers omit this;
   * pure validator treats `undefined` as "unknown but valid". */
  updatedAtMs?: number;
}

export interface RestoreSnapshotEntry {
  /** Snapshot name (e.g. "2026-01-31"). */
  name: string;
  /** ms timestamp of snapshot creation. */
  createdAtMs: number;
  /** Number of files captured in the snapshot. */
  fileCount: number;
}

export interface RestoreValidationInput {
  workspaceId: string;
  manifest: RestoreManifestEntry[];
  meta: RestoreMetaEntry[];
  snapshots: RestoreSnapshotEntry[];
  /** Caller-supplied "now" (ms). Used only for "stale snapshot" hints. */
  nowMs: number;
  /** Threshold above which a snapshot is flagged as stale. Default 90 days. */
  staleSnapshotMs?: number;
}

export type RestoreIssueKind =
  | "manifest_meta_path_mismatch"
  | "manifest_meta_hash_mismatch"
  | "meta_orphan"
  | "manifest_orphan"
  | "no_snapshots"
  | "stale_snapshot"
  | "duplicate_snapshot_name";

export type RestoreIssueSeverity = "info" | "warning" | "error";

export interface RestoreIssue {
  kind: RestoreIssueKind;
  severity: RestoreIssueSeverity;
  /** Affected path / snapshot name when applicable. */
  ref?: string;
  /** Human-readable detail for display in the OutputChannel. */
  detail: string;
}

export interface RestoreValidationReport {
  workspaceId: string;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: RestoreIssue[];
  /** True iff there are no error-level issues (warnings allowed). */
  restoreSafe: boolean;
}

const DEFAULT_STALE_SNAPSHOT_MS = 90 * 24 * 60 * 60_000;

export function validateRestoreState(input: RestoreValidationInput): RestoreValidationReport {
  const staleMs = input.staleSnapshotMs ?? DEFAULT_STALE_SNAPSHOT_MS;
  const issues: RestoreIssue[] = [];

  const manifestByPath = new Map<string, RestoreManifestEntry>();
  for (const m of input.manifest) manifestByPath.set(m.relPath, m);
  const metaByPath = new Map<string, RestoreMetaEntry>();
  for (const m of input.meta) metaByPath.set(m.relPath, m);

  // Manifest ↔ meta consistency.
  for (const [path, manifestEntry] of manifestByPath) {
    const metaEntry = metaByPath.get(path);
    if (metaEntry === undefined) {
      issues.push({
        kind: "manifest_meta_path_mismatch",
        severity: "error",
        ref: path,
        detail: `Manifest references "${path}" but meta has no entry for it.`,
      });
      continue;
    }
    if (metaEntry.hash !== manifestEntry.hash) {
      issues.push({
        kind: "manifest_meta_hash_mismatch",
        severity: "error",
        ref: path,
        detail: `Manifest hash for "${path}" does not match meta entry — restore would diverge.`,
      });
    }
  }
  for (const [path] of metaByPath) {
    if (!manifestByPath.has(path)) {
      issues.push({
        kind: "meta_orphan",
        severity: "warning",
        ref: path,
        detail: `Meta entry "${path}" has no matching manifest entry.`,
      });
    }
  }

  // Snapshots.
  if (input.snapshots.length === 0) {
    issues.push({
      kind: "no_snapshots",
      severity: "warning",
      detail: "Workspace has no snapshots — restore is possible but cannot be verified against a known-good baseline.",
    });
  }
  const seenSnapshotNames = new Set<string>();
  for (const s of input.snapshots) {
    if (seenSnapshotNames.has(s.name)) {
      issues.push({
        kind: "duplicate_snapshot_name",
        severity: "error",
        ref: s.name,
        detail: `Duplicate snapshot name "${s.name}" — restore cannot disambiguate.`,
      });
      continue;
    }
    seenSnapshotNames.add(s.name);
    if (input.nowMs - s.createdAtMs > staleMs) {
      issues.push({
        kind: "stale_snapshot",
        severity: "info",
        ref: s.name,
        detail: `Snapshot "${s.name}" is older than the staleness threshold.`,
      });
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const i of issues) {
    if (i.severity === "error") errorCount += 1;
    else if (i.severity === "warning") warningCount += 1;
    else infoCount += 1;
  }

  return {
    workspaceId: input.workspaceId,
    issueCount: issues.length,
    errorCount,
    warningCount,
    infoCount,
    issues,
    restoreSafe: errorCount === 0,
  };
}
