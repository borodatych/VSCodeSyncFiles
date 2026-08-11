/**
 * Link Bindings — logical file identity helpers (docs/v2/linkBindings.md).
 *
 * `linkId` is the stable identity of a synced file, decoupled from any
 * machine's local path. New manifest rows get a random id; legacy rows are
 * lazily backfilled with a DETERMINISTIC id derived from immutable row fields
 * (`path` + `addedAt`), so two machines backfilling concurrently write the
 * same value and converge without a merge storm. Backfill deliberately does
 * NOT bump the row's Lamport `version`: convergence here comes from
 * determinism, and a version bump would make every backfill fight real edits
 * in 412-merges.
 *
 * Both manifest transforms are copy-on-write, `purgeTombstones`-style: the
 * write path shares row objects with the manifest cache, so in-place mutation
 * would corrupt cached state behind an etag.
 */
import { createHash, randomBytes } from "node:crypto";
import type { CloudManifest, ManifestFile } from "./cloudLayout.js";

export const LINK_ID_HEX_LENGTH = 16;

/** Random identity for a freshly added manifest row. */
export function newLinkId(): string {
  return randomBytes(LINK_ID_HEX_LENGTH / 2).toString("hex");
}

/**
 * Deterministic identity for a legacy row. Stable across machines as long as
 * the row keeps its `path` + `addedAt`; a repair that rewrote `addedAt`
 * changes the result irreversibly (accepted — the merge-side linkId graft
 * covers rows that already carried an id).
 */
export function deterministicLinkId(path: string, addedAt: string): string {
  return createHash("sha256").update(`${path}\0${addedAt}`).digest("hex").slice(0, LINK_ID_HEX_LENGTH);
}

/** Default human label for a row: basename of the canonical path. */
export function defaultLinkName(posixPath: string): string {
  const ix = posixPath.lastIndexOf("/");
  return ix === -1 ? posixPath : posixPath.slice(ix + 1);
}

/**
 * Manifest `files[]` rebuilt from local tracked rows — used when the cloud
 * manifest vanished while the workspace still exists locally. Keyed
 * canonically; the machine's own placement is re-asserted as a binding so
 * other machines keep their view. (Extracted from
 * `syncEngine.rebuildManifestFromLocalState` — engine line-ceiling offset.)
 */
export function rebuildManifestFilesFromTracked(
  trackedRows: readonly { localPath: string; manifestPath?: string; linkId?: string }[],
  machineId: string,
  nowIso: string,
): ManifestFile[] {
  return trackedRows.map((f, i) => ({
    path: f.manifestPath ?? f.localPath,
    addedAt: nowIso,
    version: i + 1,
    hasSyncignoreMarkers: false,
    ...(f.linkId !== undefined ? { linkId: f.linkId } : {}),
    ...(f.manifestPath !== undefined && f.manifestPath !== f.localPath
      ? { bindings: { [machineId]: { path: f.localPath, boundAt: nowIso } } }
      : {}),
  }));
}

/**
 * Fill missing `linkId`s across manifest rows (tombstones included — a rename
 * re-association needs the tombstone's identity too). Pure; returns the same
 * object when nothing is missing.
 */
export function withBackfilledLinkIds(manifest: CloudManifest): CloudManifest {
  if (manifest.files.every((f) => f.linkId !== undefined)) {
    return manifest;
  }
  const files = manifest.files.map((f): ManifestFile =>
    f.linkId !== undefined ? f : { ...f, linkId: deterministicLinkId(f.path, f.addedAt) },
  );
  return { ...manifest, files };
}

/**
 * Drop `bindings` keys of machines no longer present in `machines[]` — the
 * bindings analogue of tombstone retention. Deterministic and version-neutral:
 * every machine computes the same result from the same manifest. Pure;
 * returns the same object when nothing is stale.
 */
export function withPrunedStaleBindings(manifest: CloudManifest): CloudManifest {
  const known = new Set(manifest.machines.map((m) => m.machineId));
  let folderBindings = manifest.folderBindings;
  if (folderBindings !== undefined) {
    const keptMachines = Object.entries(folderBindings).filter(([machineId]) => known.has(machineId));
    if (keptMachines.length !== Object.keys(folderBindings).length) {
      folderBindings = keptMachines.length > 0 ? Object.fromEntries(keptMachines) : undefined;
    }
  }
  const files = manifest.files.map((f): ManifestFile => {
    if (!f.bindings) {
      return f;
    }
    const kept = Object.entries(f.bindings).filter(([machineId]) => known.has(machineId));
    if (kept.length === Object.keys(f.bindings).length) {
      return f;
    }
    if (kept.length === 0) {
      const { bindings: _drop, ...rest } = f;
      return rest;
    }
    return { ...f, bindings: Object.fromEntries(kept) };
  });
  const filesChanged = files.some((f, i) => f !== manifest.files[i]);
  const foldersChanged = folderBindings !== manifest.folderBindings;
  if (!filesChanged && !foldersChanged) {
    return manifest;
  }
  const next: CloudManifest = { ...manifest, files: filesChanged ? files : manifest.files };
  if (foldersChanged) {
    if (folderBindings === undefined) {
      delete (next as { folderBindings?: unknown }).folderBindings;
    } else {
      next.folderBindings = folderBindings;
    }
  }
  return next;
}
