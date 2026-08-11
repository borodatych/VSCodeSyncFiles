/**
 * Link Bindings — duplicate detection at add time (docs/v2/linkBindings.md,
 * stage 2). The user may have forgotten a file is already synced (or it lives
 * in the cloud under another machine's structure): before creating a second
 * logical file, suggest binding to the existing row instead. Advisory only —
 * the caller offers, never forces.
 *
 * Pure: candidates + cloud index in, matches out. Maps keyed by hash and by
 * lowercase name give O(N+M) — bulk adds must not go quadratic.
 */

export interface CloudIndexRow {
  /** Canonical manifest path (live rows only — the caller filters tombstones). */
  path: string;
  linkName?: string;
  /** `_meta` canonical hash; absent when the blob has no meta row yet. */
  hash?: string;
}

export interface AddCandidate {
  /** Local posix-relative path of the file about to be added. */
  posixRel: string;
  /** Canonical content hash of the local file ("" when unreadable). */
  hash: string;
}

export type DuplicateMatchKind = "content" | "name" | "content+name";

export interface DuplicateMatch {
  posixRel: string;
  cloudPath: string;
  cloudLinkName?: string;
  kind: DuplicateMatchKind;
}

function basenameLower(p: string): string {
  const ix = p.lastIndexOf("/");
  return (ix === -1 ? p : p.slice(ix + 1)).toLowerCase();
}

export function planAddDuplicates(
  candidates: readonly AddCandidate[],
  cloudIndex: readonly CloudIndexRow[],
): DuplicateMatch[] {
  const byHash = new Map<string, CloudIndexRow>();
  const byName = new Map<string, CloudIndexRow>();
  for (const row of cloudIndex) {
    if (row.hash !== undefined && row.hash !== "" && !byHash.has(row.hash)) {
      byHash.set(row.hash, row);
    }
    const names = [basenameLower(row.path), row.linkName?.toLowerCase()];
    for (const n of names) {
      if (n !== undefined && n !== "" && !byName.has(n)) {
        byName.set(n, row);
      }
    }
  }
  const out: DuplicateMatch[] = [];
  for (const c of candidates) {
    const contentHit = c.hash !== "" ? byHash.get(c.hash) : undefined;
    const nameHit = byName.get(basenameLower(c.posixRel));
    const hit = contentHit ?? nameHit;
    if (!hit) {
      continue;
    }
    const kind: DuplicateMatchKind =
      contentHit !== undefined && contentHit.path === nameHit?.path
        ? "content+name"
        : contentHit !== undefined
          ? "content"
          : "name";
    out.push({ posixRel: c.posixRel, cloudPath: hit.path, cloudLinkName: hit.linkName, kind });
  }
  return out;
}
