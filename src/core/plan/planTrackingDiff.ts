/**
 * Which tracked files the cloud manifest says this machine should have.
 *
 * The comparison was written twice with different answers: `reportTrackingDrift`
 * produced two lists of paths for the notification, while
 * `adoptManifestFilesFromCloud` re-derived the same thing inline and, in the
 * same loop, decided the `cloudPath`, `localHash` and `syncStatus` of each new
 * entry. Only the second knew about renames. Keeping the decision here means
 * the notification and the action cannot disagree about what is missing.
 *
 * Pure: the caller supplies the manifest rows, what is tracked now, the meta
 * hashes, and which files exist on disk. No I/O.
 */

export interface ManifestFileRow {
  path: string;
  removedAt?: string;
  /** Set by the machine that renamed the file; used to move an entry, not duplicate it. */
  renamedFrom?: string;
}

export interface TrackingDiffInput {
  workspaceId: string;
  manifestFiles: readonly ManifestFileRow[];
  /** Tracked paths of this workspace, as recorded locally. */
  trackedPaths: readonly string[];
  /** `_meta.files[path].hash` — used as the adopted entry's baseline. */
  metaHashFor: (posixRel: string) => string | undefined;
  /** `_meta.files[path].wireGzip` — decides the `.gz` suffix of the blob path. */
  wireGzipFor: (posixRel: string) => boolean;
  /** Whether the file is present on this disk right now. */
  existsLocally: (posixRel: string) => boolean;
}

export interface AdoptedFilePlan {
  posixRel: string;
  wireGzip: boolean;
  /**
   * A file adopted from someone else's manifest exists in the cloud, not
   * necessarily on this disk. Registering it as already-synced (cloud hash in
   * `localHash`, status `ok`) is what used to leave it never pulled.
   * `missing_local` is the honest form of "not on this disk" (Link Bindings).
   */
  localHash: string;
  syncStatus: "ok" | "missing_local";
}

export interface RenamedFilePlan {
  from: string;
  to: string;
  wireGzip: boolean;
  localHash: string;
}

export interface TrackingDiff {
  /** In the manifest, not tracked here — and not the target of a rename. */
  adopt: AdoptedFilePlan[];
  /** Tracked here under the old name; the manifest moved it. */
  rename: RenamedFilePlan[];
  /** Tracked here, absent from (or tombstoned in) the manifest. */
  prune: string[];
}

export function planTrackingDiff(input: TrackingDiffInput): TrackingDiff {
  const activeRows = input.manifestFiles.filter((f) => f.removedAt === undefined || f.removedAt === "");
  const activePaths = new Set(activeRows.map((f) => f.path));
  const tracked = new Set(input.trackedPaths);

  const adopt: AdoptedFilePlan[] = [];
  const rename: RenamedFilePlan[] = [];

  for (const row of activeRows) {
    if (tracked.has(row.path)) {
      continue;
    }
    const wireGzip = input.wireGzipFor(row.path);
    const metaHash = input.metaHashFor(row.path) ?? "";
    if (row.renamedFrom !== undefined && row.renamedFrom !== "" && tracked.has(row.renamedFrom)) {
      rename.push({ from: row.renamedFrom, to: row.path, wireGzip, localHash: metaHash });
      continue;
    }
    const exists = input.existsLocally(row.path);
    adopt.push({
      posixRel: row.path,
      wireGzip,
      localHash: exists ? metaHash : "",
      syncStatus: exists ? "ok" : "missing_local",
    });
  }

  // A path that is only leaving under its old name because of a rename is not
  // "pruned" — the entry moves.
  const renamedAway = new Set(rename.map((r) => r.from));
  const prune = [...tracked].filter((p) => !activePaths.has(p) && !renamedAway.has(p));

  return { adopt, rename, prune };
}
