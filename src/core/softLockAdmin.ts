/**
 * Soft locks: the `editingBy` / `editingSince` fields of a manifest row.
 *
 * Layer 3 (этап 5.3). Soft-lock handling is the part of workspace
 * administration with a boundary that is real rather than drawn on paper: it
 * touches manifest rows and nothing else — no local files, no hashes, no blobs,
 * no `_meta`. Which makes it decidable without the engine, and testable without
 * a provider.
 *
 * A soft lock is advisory. It never blocks a write on its own; it tells other
 * machines that someone has the file open, and it ages out.
 */
import type { CloudManifest, ManifestFile } from "./cloudLayout.js";

export interface StaleLockRow {
  posixRel: string;
  machineId: string;
  editingSince: string;
  ageMs: number;
}

/**
 * Rows whose lock is older than the cutoff. One definition of "stale" for both
 * the listing and the clearing command — they used to carry a copy each.
 */
export function findStaleLocks(
  manifest: CloudManifest,
  staleAfterMs: number,
  nowMs: number,
): StaleLockRow[] {
  const out: StaleLockRow[] = [];
  for (const f of manifest.files) {
    // A tombstoned row cannot be "being edited" by anyone.
    if (f.removedAt) continue;
    if (!f.editingBy || !f.editingSince) continue;
    const since = Date.parse(f.editingSince);
    if (Number.isNaN(since)) continue;
    const ageMs = nowMs - since;
    if (ageMs < staleAfterMs) continue;
    out.push({ posixRel: f.path, machineId: f.editingBy, editingSince: f.editingSince, ageMs });
  }
  return out;
}

/**
 * Take or drop a lock on one row. Returns the new `files` array, or `null` when
 * nothing changed — so the caller can skip the upload entirely.
 *
 * The row's `version` is deliberately left alone: a lock is presence metadata,
 * not content, and bumping it made every focus change look like an edit to the
 * other machines.
 */
export function applyLockChange(
  files: readonly ManifestFile[],
  posixRel: string,
  lock: { machineId: string; sinceIso: string } | null,
): ManifestFile[] | null {
  const ix = files.findIndex((f) => f.path === posixRel);
  if (ix < 0) return null;
  const cur = files[ix];
  const next: ManifestFile =
    lock === null
      ? stripLock(cur)
      : { ...cur, editingBy: lock.machineId, editingSince: lock.sinceIso };
  if (cur.editingBy === next.editingBy && cur.editingSince === next.editingSince) {
    return null;
  }
  const out = [...files];
  out[ix] = next;
  return out;
}

function stripLock(f: ManifestFile): ManifestFile {
  const { editingBy: _by, editingSince: _since, ...rest } = f;
  return rest;
}
