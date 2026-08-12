/**
 * Prior canonical keys of a live manifest row — the rename trail a file left
 * behind (docs/v3/canonicalPaths.md). `.history/` snapshots live under the key
 * that was canonical when they were taken, so reading a renamed file's history
 * means walking this chain and merging the per-key directories.
 *
 * The walk follows `renamedFrom` breadcrumbs: A→B→C leaves row C
 * (renamedFrom=B) plus tombstones B (renamedFrom=A) and A. A tombstone that
 * merely shares the linkId is NOT part of the trail — repairDuplicateLinkIds
 * tombstones losing carriers of the same id, and treating those as renames
 * would graft a stranger's history onto this file. Breadcrumbs and tombstones
 * purge together after ~30 days, so the chain is honestly bounded — snapshots
 * older than the purge window stay under keys nothing points to (the orphan
 * GC's problem, not the reader's).
 */
import type { ManifestFile } from "./cloudLayout.js";

export const MAX_CHAIN_DEPTH = 32;

/**
 * Keys the row previously lived under, newest first, excluding the live key
 * itself. Pure; tolerant of cycles and of rows whose linkId disagrees (a
 * reused path can leave a tombstone of an unrelated file at a chain key).
 */
export function priorCanonicalKeys(
  files: readonly ManifestFile[],
  liveKey: string,
): string[] {
  const byPath = new Map<string, ManifestFile>();
  for (const f of files) {
    // Prefer the live row when a path briefly has both (resumed rename).
    const prev = byPath.get(f.path);
    if (prev === undefined || (prev.removedAt !== undefined && f.removedAt === undefined)) {
      byPath.set(f.path, f);
    }
  }
  const live = byPath.get(liveKey);
  if (!live) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>([liveKey]);
  let current: ManifestFile | undefined = live;
  while (current?.renamedFrom !== undefined && current.renamedFrom !== "" && out.length < MAX_CHAIN_DEPTH) {
    const fromKey: string = current.renamedFrom;
    if (seen.has(fromKey)) {
      break; // cycle — corrupt trail, stop rather than loop
    }
    seen.add(fromKey);
    // The key itself is ours — we renamed away from it, our snapshots are
    // there. But if the row now AT that key carries a different linkId, the
    // path was reused by an unrelated file: keep the key, do not follow the
    // stranger's own breadcrumbs any further.
    out.push(fromKey);
    const prevRow = byPath.get(fromKey);
    if (
      prevRow?.linkId !== undefined &&
      current.linkId !== undefined &&
      prevRow.linkId !== current.linkId
    ) {
      break;
    }
    current = prevRow;
  }
  return out;
}
