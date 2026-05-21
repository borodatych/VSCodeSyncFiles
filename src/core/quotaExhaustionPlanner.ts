/**
 * v0.8 — pure planner for the quota-exhaustion banner.
 *
 * Inputs: per-file metadata for all tracked files (size + last sync).
 * Outputs:
 *   - top N heaviest files (with workspace label, posix rel, bytes, lastSync)
 *   - total bytes across all tracked files
 *   - a suggestion bucket: which subset to consider untracking / archiving
 *
 * No `vscode` import. Used by the UI banner after a provider raises
 * `STORAGE_QUOTA_EXCEEDED`.
 */

export interface TrackedFileWeight {
  workspaceId: string;
  workspaceNote: string;
  posixRel: string;
  bytes: number;
  lastSyncIso?: string;
}

export interface QuotaExhaustionPlan {
  topHeavy: TrackedFileWeight[];
  totalBytes: number;
  /**
   * Aggregated bytes the user could reclaim by untracking only the
   * `topHeavy` set. Convenient for the banner copy: «снимите N файлов →
   * освободит ~X МБ».
   */
  reclaimIfUntrackTop: number;
  /** Buckets the top files into "stale" (>30d since lastSync) vs "fresh". */
  staleTopBytes: number;
  freshTopBytes: number;
}

export interface QuotaExhaustionPlanOptions {
  /** How many of the heaviest files to show in the banner. Default 5. */
  topN?: number;
  /** Cutoff for "stale" — files not touched in this many days. Default 30. */
  staleDays?: number;
  /** ms — "now" for tests. */
  nowMs?: number;
}

export function planQuotaExhaustion(
  files: readonly TrackedFileWeight[],
  opts: QuotaExhaustionPlanOptions = {},
): QuotaExhaustionPlan {
  const topN = Math.max(1, Math.min(50, opts.topN ?? 5));
  const staleDays = Math.max(0, opts.staleDays ?? 30);
  const now = opts.nowMs ?? Date.now();
  const staleCutoffMs = now - staleDays * 86_400_000;

  let totalBytes = 0;
  const sortable = files.slice();
  for (const f of sortable) totalBytes += Math.max(0, f.bytes);

  sortable.sort((a, b) => b.bytes - a.bytes);
  const topHeavy = sortable.slice(0, topN);

  let reclaim = 0;
  let staleTop = 0;
  let freshTop = 0;
  for (const f of topHeavy) {
    reclaim += f.bytes;
    const lastMs = f.lastSyncIso ? Date.parse(f.lastSyncIso) : NaN;
    if (Number.isFinite(lastMs) && lastMs < staleCutoffMs) {
      staleTop += f.bytes;
    } else {
      freshTop += f.bytes;
    }
  }

  return {
    topHeavy,
    totalBytes,
    reclaimIfUntrackTop: reclaim,
    staleTopBytes: staleTop,
    freshTopBytes: freshTop,
  };
}

/** Pretty-format bytes for the banner (B / KB / MB / GB). Pure. */
export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
