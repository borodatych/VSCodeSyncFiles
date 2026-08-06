/**
 * Timestamped copies of user files before we overwrite them.
 *
 * Extracted from `syncEngine.ts` (stage 3.6): pull was the only writer that
 * kept a pre-overwrite copy, while AI merge, Quick Transfer receive and the
 * P2P apply step overwrote user files with no way back. All four now share
 * this module.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { planLocalBackupRetention } from "./localBackupRetentionPlan.js";

export const LOCAL_BACKUP_DIR_DEFAULT = path.join(".vscode", "vscodesync-local-backup");

export function localBackupStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/** Recover the creation time from a folder name written by {@link localBackupStamp}. */
export function parseLocalBackupStamp(name: string): number | undefined {
  const iso = name.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})Z$/,
    (_m, d: string, h: string, mi: string, s: string) => `${d}${h}:${mi}:${s}Z`,
  );
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Last prune per backup root. Pruning used to run once **per pulled file**:
 * `readdir` plus a `stat` for every existing folder, sequentially, on the
 * extension host thread, inside `.vscode/` where VS Code's own watcher is
 * listening. With 1500 folders accumulated a 500-file pull meant on the order
 * of 10^5–10^6 stat calls for work that only needs doing occasionally.
 */
const lastLocalBackupPruneMs = new Map<string, number>();
const LOCAL_BACKUP_PRUNE_INTERVAL_MS = 5 * 60_000;

export async function backupLocalWithPrune(
  localFileAbs: string,
  workspaceRoot: string,
  posixRelMirror: string,
  retentionDays: number,
  backupDir: string,
): Promise<void> {
  const src = localFileAbs;
  const now = Date.now();
  const dest = path.join(
    workspaceRoot,
    backupDir,
    localBackupStamp(now),
    ...posixRelMirror.split("/"),
  );
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  if (retentionDays <= 0) return;

  const root = path.join(workspaceRoot, backupDir);
  const last = lastLocalBackupPruneMs.get(root) ?? 0;
  if (now - last < LOCAL_BACKUP_PRUNE_INTERVAL_MS) return;
  lastLocalBackupPruneMs.set(root, now);
  await pruneLocalBackups(workspaceRoot, retentionDays, backupDir);
}

export async function pruneLocalBackups(
  workspaceRoot: string,
  retentionDays: number,
  backupDir: string,
): Promise<void> {
  const root = path.join(workspaceRoot, backupDir);
  let dirents: Awaited<ReturnType<typeof fs.readdir>> | { name: string; isDirectory: () => boolean }[];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const entries: { name: string; mtimeMs: number; isDirectory: boolean }[] = [];
  for (const d of dirents as { name: string; isDirectory: () => boolean }[]) {
    const name = d.name;
    const isDirectory = d.isDirectory();
    // The folder name carries its own timestamp, so the usual case needs no
    // `stat` at all; only names we cannot parse fall back to one.
    const fromName = parseLocalBackupStamp(name);
    if (fromName !== undefined) {
      entries.push({ name, mtimeMs: fromName, isDirectory });
      continue;
    }
    try {
      const st = await fs.stat(path.join(root, name));
      entries.push({ name, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
    } catch {
      /* skip — disappeared between readdir and stat */
    }
  }
  const plan = planLocalBackupRetention({ entries, retentionDays });
  await Promise.all(
    plan.delete.map((name) => fs.rm(path.join(root, name), { recursive: true, force: true })),
  );
}

/**
 * Overwrite a user file, keeping a timestamped copy of what was there.
 *
 * Returns `true` when a backup was made (i.e. the destination existed).
 * Missing destination is not an error — nothing is lost, so nothing is copied.
 */
export async function backupExistingUserFile(opts: {
  absPath: string;
  workspaceRoot: string;
  posixRel: string;
  retentionDays?: number;
  backupDir?: string;
}): Promise<boolean> {
  try {
    await fs.access(opts.absPath);
  } catch {
    return false;
  }
  await backupLocalWithPrune(
    opts.absPath,
    opts.workspaceRoot,
    opts.posixRel,
    opts.retentionDays ?? 7,
    opts.backupDir ?? LOCAL_BACKUP_DIR_DEFAULT,
  );
  return true;
}
