/**
 * v3.D — pure planner for encryption-key rotation across encrypted workspaces.
 *
 * Caller (rotation wizard UI) provides the inventory of files-to-rotate; this
 * module produces deterministic batches of work items so the wizard can show
 * progress and resume after interruption.
 *
 * Resumability state is the caller's responsibility — they persist completed
 * keys to `_meta.json.rotationInProgress`. This planner just splits the queue.
 */

export interface RotationFileItem {
  workspaceId: string;
  /** POSIX-relative path inside the workspace. */
  relPath: string;
  /** Total bytes (encrypted blob) — drives batch sizing. */
  sizeBytes: number;
  /** Already migrated (e.g. resumed run). */
  done?: boolean;
}

export interface RotationBatch {
  batchIndex: number;
  items: RotationFileItem[];
  totalBytes: number;
}

export interface RotationPlan {
  batches: RotationBatch[];
  totalFiles: number;
  totalBytes: number;
  remainingFiles: number;
  remainingBytes: number;
}

export interface PlanRotationOptions {
  /** Hard cap on bytes per batch (default 50 MB). */
  maxBytesPerBatch?: number;
  /** Hard cap on files per batch (default 100). */
  maxFilesPerBatch?: number;
}

export const DEFAULT_MAX_BYTES_PER_BATCH = 50 * 1024 * 1024;
export const DEFAULT_MAX_FILES_PER_BATCH = 100;

/** Build batches of pending rotations. Already-done items are accounted in
 * totals but excluded from batches. Order is workspaceId, then relPath
 * (deterministic). */
export function planKeyRotation(
  items: RotationFileItem[],
  options: PlanRotationOptions = {},
): RotationPlan {
  const maxBytes = options.maxBytesPerBatch ?? DEFAULT_MAX_BYTES_PER_BATCH;
  const maxFiles = options.maxFilesPerBatch ?? DEFAULT_MAX_FILES_PER_BATCH;

  let totalFiles = 0;
  let totalBytes = 0;
  for (const it of items) {
    totalFiles += 1;
    totalBytes += it.sizeBytes;
  }

  const pending = items
    .filter((i) => !i.done)
    .sort((a, b) =>
      a.workspaceId === b.workspaceId
        ? a.relPath.localeCompare(b.relPath)
        : a.workspaceId.localeCompare(b.workspaceId),
    );

  const batches: RotationBatch[] = [];
  let cur: RotationFileItem[] = [];
  let curBytes = 0;
  for (const it of pending) {
    if (
      cur.length > 0 &&
      (cur.length >= maxFiles || curBytes + it.sizeBytes > maxBytes)
    ) {
      batches.push({ batchIndex: batches.length, items: cur, totalBytes: curBytes });
      cur = [];
      curBytes = 0;
    }
    cur.push(it);
    curBytes += it.sizeBytes;
  }
  if (cur.length > 0) {
    batches.push({ batchIndex: batches.length, items: cur, totalBytes: curBytes });
  }

  let remainingFiles = 0;
  let remainingBytes = 0;
  for (const b of batches) {
    remainingFiles += b.items.length;
    remainingBytes += b.totalBytes;
  }

  return { batches, totalFiles, totalBytes, remainingFiles, remainingBytes };
}
