/**
 * Pure planner for `vscodesync.localBackupRetentionDays` cleanup. Today the
 * pruning logic is inlined in `syncEngine.pruneLocalBackups` and decides
 * what to delete based on `mtime`. Extracted here so it can be unit-tested
 * without staging real directories on disk.
 *
 * Inputs are the names + mtimes already collected by the caller's
 * `fs.readdir + fs.stat` loop. The planner answers "which entries are past
 * the cutoff and should be `fs.rm`-ed".
 *
 * No `vscode`, no IO.
 */

export interface LocalBackupEntry {
  /** Directory name under `LOCAL_BACKUP_DIR`. */
  name: string;
  /** Last-modified time in ms (from `fs.Stats.mtimeMs`). */
  mtimeMs: number;
  /** `true` when `fs.Stats.isDirectory()` returned `true`. The planner
   *  drops only directories — backup snapshots live as folders. */
  isDirectory: boolean;
}

export interface LocalBackupRetentionInput {
  entries: readonly LocalBackupEntry[];
  /** From `vscodesync.localBackupRetentionDays`. Non-positive disables prune. */
  retentionDays: number;
  /** Wall-clock used to compute the cutoff. Defaults to `Date.now()`. */
  nowMs?: number;
}

export interface LocalBackupRetentionPlan {
  /** Names safe to leave untouched. */
  keep: string[];
  /** Names the caller should `fs.rm({ recursive: true, force: true })`. */
  delete: string[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function planLocalBackupRetention(
  input: LocalBackupRetentionInput,
): LocalBackupRetentionPlan {
  if (input.retentionDays <= 0) {
    // Match the engine's behaviour: retentionDays <= 0 disables prune.
    return { keep: input.entries.map((e) => e.name), delete: [] };
  }
  const now = input.nowMs ?? Date.now();
  const cutoff = now - input.retentionDays * MS_PER_DAY;
  const keep: string[] = [];
  const del: string[] = [];
  for (const e of input.entries) {
    if (!e.isDirectory) {
      // Skip non-directories — engine ignores these too.
      keep.push(e.name);
      continue;
    }
    if (e.mtimeMs < cutoff) {
      del.push(e.name);
    } else {
      keep.push(e.name);
    }
  }
  return { keep, delete: del };
}
