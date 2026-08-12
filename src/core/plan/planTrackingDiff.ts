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
  /** Row identity — cached into the adopted tracked row for rename re-association. */
  linkId?: string;
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
  /**
   * Locally cached `linkId` of a tracked key — feeds the identity-pairing
   * phase. Optional: without it renames are detected by `renamedFrom` only.
   */
  trackedLinkIdOf?: (trackedKey: string) => string | undefined;
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
  /** Manifest row identity to cache locally (undefined on legacy rows). */
  linkId?: string;
}

export interface RenamedFilePlan {
  from: string;
  to: string;
  wireGzip: boolean;
  localHash: string;
  /** Manifest row identity to cache locally (undefined on legacy rows). */
  linkId?: string;
}

export interface TrackingDiff {
  /** In the manifest, not tracked here — and not the target of a rename. */
  adopt: AdoptedFilePlan[];
  /** Tracked here under the old name; the manifest moved it. */
  rename: RenamedFilePlan[];
  /** Tracked here, absent from (or tombstoned in) the manifest. */
  prune: string[];
}

export interface ReplayedRenameNotice {
  from: string;
  to: string;
  localPlacement: string;
}

/**
 * Apply a {@link TrackingDiff} to the tracked rows of one workspace, in place.
 *
 * The replay contract (docs/v2/linkBindings.md): a canonical rename moves only
 * the KEY when this machine holds the bytes — the row keeps its `localPath`
 * and the physical move stays an explicit user action (returned as notices for
 * the UI). A row with no local bytes follows the rename to its
 * folder-rule-mapped placement. The identity cache rides every touched row —
 * after the 30-day `renamedFrom` purge, re-association has nothing else.
 * Pure apart from mutating `files`; disk existence is precomputed by the caller.
 */
export function applyTrackingDiff(input: {
  workspaceId: string;
  /** All tracked rows (every workspace); mutated in place. */
  files: {
    localPath: string;
    workspaceId: string;
    cloudPath: string;
    lastSync: string;
    localHash: string;
    syncStatus?: string;
    manifestPath?: string;
    linkId?: string;
  }[];
  diff: TrackingDiff;
  placementOf: (posixRel: string) => string;
  /** Whether this machine holds bytes at the row's current placement. */
  bytesAtPlacement: (localPath: string) => boolean;
  blobPathOf: (posixRel: string, wireGzip: boolean) => string;
  nowIso: string;
}): { changed: boolean; replayed: ReplayedRenameNotice[] } {
  const { files, diff, workspaceId } = input;
  const keyOf = (f: { localPath: string; manifestPath?: string }): string => f.manifestPath ?? f.localPath;
  let changed = false;
  const replayed: ReplayedRenameNotice[] = [];
  for (const r of diff.rename) {
    const ix = files.findIndex((f) => f.workspaceId === workspaceId && keyOf(f) === r.from);
    if (ix < 0) continue;
    const prev = files[ix];
    const replayLinkId = r.linkId ?? prev.linkId;
    if (input.bytesAtPlacement(prev.localPath)) {
      files[ix] = {
        ...prev,
        manifestPath: prev.localPath === r.to ? undefined : r.to,
        cloudPath: input.blobPathOf(r.to, r.wireGzip),
        ...(replayLinkId !== undefined ? { linkId: replayLinkId } : {}),
      };
      if (prev.localPath !== r.to) {
        replayed.push({ from: r.from, to: r.to, localPlacement: prev.localPath });
      }
    } else {
      const placement = input.placementOf(r.to);
      files[ix] = {
        ...prev,
        localPath: placement,
        manifestPath: placement === r.to ? undefined : r.to,
        cloudPath: input.blobPathOf(r.to, r.wireGzip),
        localHash: r.localHash,
        ...(replayLinkId !== undefined ? { linkId: replayLinkId } : {}),
      };
    }
    changed = true;
  }
  for (const a of diff.adopt) {
    const placement = input.placementOf(a.posixRel);
    files.push({
      localPath: placement,
      workspaceId,
      cloudPath: input.blobPathOf(a.posixRel, a.wireGzip),
      lastSync: input.nowIso,
      localHash: a.localHash,
      syncStatus: a.syncStatus,
      ...(placement !== a.posixRel ? { manifestPath: a.posixRel } : {}),
      ...(a.linkId !== undefined ? { linkId: a.linkId } : {}),
    });
    changed = true;
  }
  return { changed, replayed };
}

/**
 * Tracked rows the manifest no longer lists — candidates for the "these files
 * would be silently pruned" warning. A key that an active row renamed away
 * from, or whose identity (`linkId`) lives on under another path, is about to
 * be MOVED by adopt, not pruned — warning about it would cry wolf on every
 * canonical rename. Pure; the caller still checks the disk.
 */
export function planPurgeLostCandidates<T extends { linkId?: string }>(
  manifestFiles: readonly (ManifestFileRow & { linkId?: string })[],
  trackedRows: readonly T[],
  keyOf: (row: T) => string,
): T[] {
  const activeRows = manifestFiles.filter((f) => !f.removedAt);
  const activePaths = new Set(activeRows.map((f) => f.path));
  const renamedAway = new Set(activeRows.map((f) => f.renamedFrom).filter((p): p is string => !!p));
  const activeLinkIds = new Set(activeRows.map((f) => f.linkId).filter((id): id is string => id !== undefined));
  return trackedRows.filter(
    (f) =>
      !activePaths.has(keyOf(f)) &&
      !renamedAway.has(keyOf(f)) &&
      !(f.linkId !== undefined && activeLinkIds.has(f.linkId)),
  );
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
      rename.push({
        from: row.renamedFrom,
        to: row.path,
        wireGzip,
        localHash: metaHash,
        ...(row.linkId !== undefined ? { linkId: row.linkId } : {}),
      });
      continue;
    }
    const exists = input.existsLocally(row.path);
    adopt.push({
      posixRel: row.path,
      wireGzip,
      localHash: exists ? metaHash : "",
      syncStatus: exists ? "ok" : "missing_local",
      ...(row.linkId !== undefined ? { linkId: row.linkId } : {}),
    });
  }

  // A path that is only leaving under its old name because of a rename is not
  // "pruned" — the entry moves.
  const renamedAway = new Set(rename.map((r) => r.from));
  let prune = [...tracked].filter((p) => !activePaths.has(p) && !renamedAway.has(p));

  // Phase 2 — identity pairing. `renamedFrom` is one-step and purged after 30
  // days: a machine returning from long offline, or one that slept through a
  // chain a→b→c, would see "prune + adopt" and duplicate the file on disk.
  // The cached linkId still names the row, so an unambiguous (1 leaving key ↔
  // 1 arriving row) identity match converts the pair into a rename. Ambiguous
  // identities (duplicate carriers pending repair) are left alone.
  if (input.trackedLinkIdOf && prune.length > 0 && adopt.length > 0) {
    const leavingByLinkId = new Map<string, string[]>();
    for (const p of prune) {
      const id = input.trackedLinkIdOf(p);
      if (id === undefined) continue;
      const paths = leavingByLinkId.get(id);
      if (paths) paths.push(p);
      else leavingByLinkId.set(id, [p]);
    }
    const arrivingByLinkId = new Map<string, AdoptedFilePlan[]>();
    for (const a of adopt) {
      if (a.linkId === undefined) continue;
      const plans = arrivingByLinkId.get(a.linkId);
      if (plans) plans.push(a);
      else arrivingByLinkId.set(a.linkId, [a]);
    }
    const pairedAdopts = new Set<AdoptedFilePlan>();
    const pairedPrunes = new Set<string>();
    for (const [linkId, leaving] of leavingByLinkId) {
      const arriving = arrivingByLinkId.get(linkId);
      if (!arriving || leaving.length !== 1 || arriving.length !== 1) continue;
      rename.push({
        from: leaving[0],
        to: arriving[0].posixRel,
        wireGzip: arriving[0].wireGzip,
        localHash: input.metaHashFor(arriving[0].posixRel) ?? "",
        linkId,
      });
      pairedAdopts.add(arriving[0]);
      pairedPrunes.add(leaving[0]);
    }
    if (pairedAdopts.size > 0) {
      const keptAdopt = adopt.filter((a) => !pairedAdopts.has(a));
      adopt.length = 0;
      adopt.push(...keptAdopt);
      prune = prune.filter((p) => !pairedPrunes.has(p));
    }
  }

  return { adopt, rename, prune };
}
