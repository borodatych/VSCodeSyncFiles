/**
 * Link Bindings (docs/v2/linkBindings.md): pure planner for binding an
 * existing local file to a live manifest row. The engine does the I/O
 * (manifest download/PUT, hashing, config save); every decision — guards,
 * the updated manifest row, the tracked-file row — is made here so it is
 * testable without a cloud.
 *
 * Pure: rows and hashes in, verdict out. No I/O, no engine state, no `vscode`.
 */
import type { BindingEntry, ManifestFile, MetaEntry } from "../cloudLayout.js";
import type { TrackedFile } from "../types.js";
import { manifestKeyOf } from "../trackedPathResolver.js";
import { blobCloudPath } from "../wireCompression.js";

export interface BindPlanInput {
  workspaceId: string;
  /** Canonical manifest key the user picked (`ManifestFile.path`). */
  manifestKey: string;
  /** Where the file lives on THIS machine (posix-relative to the sync root). */
  localPosixRel: string;
  machineId: string;
  /** All tracked rows of this workspace from `.vscode/vscodesync.json`. */
  trackedFiles: readonly TrackedFile[];
  manifestFiles: readonly ManifestFile[];
  metaEntry: MetaEntry | undefined;
  /** Canonical hash of the local file on disk. */
  localHash: string;
  /** Workspace-wide next Lamport version (max over rows + 1). */
  nextVersion: number;
  nowIso: string;
  replaceExisting: boolean;
}

export type BindPlan =
  | { ok: false; reason: BindRejection; detail: string }
  | {
      ok: true;
      /** Manifest row to substitute for the original (bindings + version bump). */
      updatedRow: ManifestFile;
      /** Tracked row to upsert; replaces prior rows for this key or local path. */
      tracked: TrackedFile;
      contentMatches: boolean;
    };

export type BindRejection =
  | "row_not_found"
  | "row_deleted"
  | "local_path_tracked"
  | "already_bound";

/** Typed rejection so the UI can answer each reason differently. */
export class BindRejectedError extends Error {
  constructor(
    readonly rejection: BindRejection,
    readonly detail: string,
  ) {
    super(`bindLocalFile rejected (${rejection}): ${detail}`);
    this.name = "BindRejectedError";
  }
}

export function planBindLocalFile(input: BindPlanInput): BindPlan {
  const row = input.manifestFiles.find((f) => f.path === input.manifestKey);
  if (!row) {
    return { ok: false, reason: "row_not_found", detail: input.manifestKey };
  }
  if (row.removedAt) {
    // Anti-resurrect: binding must not race a deletion back to life. The
    // caller offers "add as new" instead of leaving this to the version race.
    return { ok: false, reason: "row_deleted", detail: input.manifestKey };
  }
  const trackedAtLocal = input.trackedFiles.find(
    (f) => f.workspaceId === input.workspaceId && f.localPath === input.localPosixRel,
  );
  if (trackedAtLocal && manifestKeyOf(trackedAtLocal) !== input.manifestKey) {
    return { ok: false, reason: "local_path_tracked", detail: manifestKeyOf(trackedAtLocal) };
  }
  const boundHere = input.trackedFiles.find(
    (f) => f.workspaceId === input.workspaceId && manifestKeyOf(f) === input.manifestKey,
  );
  if (boundHere !== undefined && boundHere.localPath !== input.localPosixRel && !input.replaceExisting) {
    return { ok: false, reason: "already_bound", detail: boundHere.localPath };
  }

  const contentMatches = input.localHash !== "" && input.localHash === input.metaEntry?.hash;
  const binding: BindingEntry = { path: input.localPosixRel, boundAt: input.nowIso };
  const updatedRow: ManifestFile = {
    ...row,
    version: Math.max(input.nextVersion, row.version + 1),
    bindings: {
      ...row.bindings,
      // Unbind convention: binding back to the canonical path still WRITES the
      // key (deleting it would resurrect via union-merge on old copies).
      [input.machineId]: binding,
    },
  };
  const tracked: TrackedFile = {
    localPath: input.localPosixRel,
    workspaceId: input.workspaceId,
    cloudPath: blobCloudPath(input.workspaceId, input.manifestKey, input.metaEntry?.wireGzip === true),
    lastSync: input.nowIso,
    localHash: contentMatches ? input.localHash : "",
    syncStatus: contentMatches ? "ok" : "cloud_newer",
    ...(input.localPosixRel !== input.manifestKey ? { manifestPath: input.manifestKey } : {}),
    ...(updatedRow.linkId !== undefined ? { linkId: updatedRow.linkId } : {}),
  };
  return { ok: true, updatedRow, tracked, contentMatches };
}
