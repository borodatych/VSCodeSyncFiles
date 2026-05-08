/**
 * v3.I — pure planner that compares a primary-cloud manifest against a
 * secondary-cloud (backup) manifest and reports which entries diverge.
 *
 * The cross-cloud backup job (`crossCloudBackup.ts`) writes manifests to a
 * secondary provider; this module answers: "is the backup fresh and
 * consistent enough that it could be restored from?"
 *
 * No `vscode` import. Caller fetches both manifests via providers separately.
 */

export interface BackupManifestEntry {
  /** POSIX-relative path inside the workspace. */
  relPath: string;
  /** Lowercase hex SHA-256 (or BLAKE3 if dual-hash) of canonical content. */
  hash: string;
  /** Optional hashBlake3 if the writer was on dual / blake3 mode. */
  hashBlake3?: string;
  /** ms timestamp of when this entry was last written. */
  updatedAtMs: number;
}

export type BackupVerifyMismatchKind =
  | "missing_in_secondary"
  | "hash_mismatch"
  | "stale_in_secondary"
  | "extra_in_secondary";

export interface BackupVerifyMismatch {
  relPath: string;
  kind: BackupVerifyMismatchKind;
  /** Optional fields populated where relevant. */
  primaryHash?: string;
  secondaryHash?: string;
  primaryUpdatedAtMs?: number;
  secondaryUpdatedAtMs?: number;
}

export interface BackupVerifyReport {
  workspaceId: string;
  primaryEntryCount: number;
  secondaryEntryCount: number;
  matchCount: number;
  mismatchCount: number;
  mismatches: BackupVerifyMismatch[];
  /** True iff every primary entry has a fresh, hash-matching secondary entry
   * (and there are no extras). Caller surfaces this as the verdict. */
  consistent: boolean;
}

export interface BackupVerifyOptions {
  /** Allow secondary to be N ms behind primary before flagging stale. */
  freshnessSlackMs?: number;
}

const DEFAULT_FRESHNESS_SLACK_MS = 24 * 60 * 60_000; // 24h — backup runs daily

export function planBackupVerify(
  workspaceId: string,
  primary: BackupManifestEntry[],
  secondary: BackupManifestEntry[],
  options: BackupVerifyOptions = {},
): BackupVerifyReport {
  const slackMs = options.freshnessSlackMs ?? DEFAULT_FRESHNESS_SLACK_MS;
  const secondaryByPath = new Map<string, BackupManifestEntry>();
  for (const e of secondary) secondaryByPath.set(e.relPath, e);

  const mismatches: BackupVerifyMismatch[] = [];
  let matches = 0;

  for (const p of primary) {
    const s = secondaryByPath.get(p.relPath);
    if (!s) {
      mismatches.push({
        relPath: p.relPath,
        kind: "missing_in_secondary",
        primaryHash: p.hash,
        primaryUpdatedAtMs: p.updatedAtMs,
      });
      continue;
    }
    // We've now matched a primary entry against a secondary entry by path.
    // Either way (match, stale, mismatch), the secondary is "consumed" so it
    // does not land in the extras bucket below.
    secondaryByPath.delete(p.relPath);
    if (s.hash !== p.hash) {
      // Allow the backup to lag — only flag hash_mismatch when the secondary
      // claims to be at least as recent as primary minus slack but the hash
      // differs. Otherwise it is stale_in_secondary and the operator should
      // wait for the next backup cycle, not a verify alert.
      if (s.updatedAtMs + slackMs >= p.updatedAtMs) {
        mismatches.push({
          relPath: p.relPath,
          kind: "hash_mismatch",
          primaryHash: p.hash,
          secondaryHash: s.hash,
          primaryUpdatedAtMs: p.updatedAtMs,
          secondaryUpdatedAtMs: s.updatedAtMs,
        });
      } else {
        mismatches.push({
          relPath: p.relPath,
          kind: "stale_in_secondary",
          primaryHash: p.hash,
          secondaryHash: s.hash,
          primaryUpdatedAtMs: p.updatedAtMs,
          secondaryUpdatedAtMs: s.updatedAtMs,
        });
      }
      continue;
    }
    matches += 1;
  }

  // Whatever remains in secondaryByPath is "extra" relative to primary.
  for (const s of secondaryByPath.values()) {
    mismatches.push({
      relPath: s.relPath,
      kind: "extra_in_secondary",
      secondaryHash: s.hash,
      secondaryUpdatedAtMs: s.updatedAtMs,
    });
  }

  return {
    workspaceId,
    primaryEntryCount: primary.length,
    secondaryEntryCount: secondary.length,
    matchCount: matches,
    mismatchCount: mismatches.length,
    mismatches,
    consistent: mismatches.length === 0,
  };
}

/** Severity ladder for the dashboard. */
export type BackupVerifySeverity = "ok" | "drift" | "stale" | "broken";

export function scoreVerifyReport(report: BackupVerifyReport): BackupVerifySeverity {
  if (report.consistent) return "ok";
  const hasHashMismatch = report.mismatches.some((m) => m.kind === "hash_mismatch");
  const hasMissing = report.mismatches.some((m) => m.kind === "missing_in_secondary");
  if (hasHashMismatch) return "broken";
  if (hasMissing) return "broken";
  // Only stale or extras → minor severity.
  const allStale = report.mismatches.every((m) => m.kind === "stale_in_secondary");
  if (allStale) return "stale";
  return "drift";
}
