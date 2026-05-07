/**
 * Pure aggregator for cloud storage usage. Takes a flat list of cloud-side
 * file metadata (the same shape `ICloudProvider.listFolder` returns) and
 * produces a per-workspace breakdown plus the global top-N largest files.
 *
 * Designed to be vscode-free so unit tests don't need a real provider.
 */

export interface StorageEntry {
  /** Cloud path; expected layout: `VSCodeSyncFiles/{workspaceId}/...` or `_machines.json` etc. */
  cloudPath: string;
  /** Bytes; entries with undefined size are treated as folders and skipped. */
  size?: number;
}

export interface WorkspaceUsage {
  workspaceId: string;
  fileCount: number;
  totalBytes: number;
}

export interface TopFileEntry {
  cloudPath: string;
  workspaceId: string | undefined;
  size: number;
}

export interface StorageUsageReport {
  totalBytes: number;
  totalFiles: number;
  perWorkspace: WorkspaceUsage[];
  topFiles: TopFileEntry[];
}

const DEFAULT_TOP_N = 10;

/**
 * Extract `{workspaceId}` from a cloud path. Returns undefined for global
 * files (`VSCodeSyncFiles/_machines.json`, `_quicktransfer/...`) or any path
 * that doesn't match `VSCodeSyncFiles/<id>/...`.
 */
export function workspaceIdFromCloudPath(cloudPath: string): string | undefined {
  const m = /^VSCodeSyncFiles\/([^/]+)\//.exec(cloudPath);
  if (!m) return undefined;
  const id = m[1];
  if (!id || id.startsWith("_")) return undefined;
  return id;
}

export function buildStorageUsageReport(
  entries: readonly StorageEntry[],
  topN: number = DEFAULT_TOP_N,
): StorageUsageReport {
  const perWsMap = new Map<string, WorkspaceUsage>();
  const sized: TopFileEntry[] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const e of entries) {
    if (e.size === undefined) continue;
    if (!Number.isFinite(e.size) || e.size < 0) continue;
    totalFiles++;
    totalBytes += e.size;
    const wsId = workspaceIdFromCloudPath(e.cloudPath);
    if (wsId !== undefined) {
      const cur = perWsMap.get(wsId) ?? { workspaceId: wsId, fileCount: 0, totalBytes: 0 };
      cur.fileCount++;
      cur.totalBytes += e.size;
      perWsMap.set(wsId, cur);
    }
    sized.push({ cloudPath: e.cloudPath, workspaceId: wsId, size: e.size });
  }
  const perWorkspace = [...perWsMap.values()].sort((a, b) => b.totalBytes - a.totalBytes);
  const topFiles = sized
    .sort((a, b) => b.size - a.size)
    .slice(0, Math.max(0, topN));
  return { totalBytes, totalFiles, perWorkspace, topFiles };
}

/** Format bytes for UI: 1.5 MB / 250 KB / 12 B. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
