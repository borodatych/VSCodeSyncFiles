/**
 * Link Bindings — binding self-heal (docs/v2/linkBindings.md, stage 3).
 *
 * A v1 machine performing a 412-merge has no per-key bindings union: row-LWW
 * can drop this machine's binding from the cloud copy. The local config stays
 * authoritative for THIS machine's placement, so a user-triggered pass
 * re-asserts it. Placements already explained by a folder rule need no
 * per-file binding; rows gone from the manifest are the prune flow's problem.
 *
 * Pure: rows in, rows-to-substitute out. Rate limiting lives with the caller.
 */
import type { ManifestFile } from "../cloudLayout.js";
import { canonicalKeyForLocalPath, type FolderBindingRules } from "../folderBindings.js";
import { manifestKeyOf } from "../trackedPathResolver.js";
import type { TrackedFile } from "../types.js";

export function planBindingSelfHeal(input: {
  machineId: string;
  /** Tracked rows of ONE workspace. */
  trackedFiles: readonly TrackedFile[];
  manifestFiles: readonly ManifestFile[];
  folderRules: FolderBindingRules;
  /** Workspace-wide next Lamport version. */
  nextVersion: number;
  nowIso: string;
}): { healedRows: Map<string, ManifestFile> } {
  const healedRows = new Map<string, ManifestFile>();
  let version = input.nextVersion;
  for (const f of input.trackedFiles) {
    const key = manifestKeyOf(f);
    if (f.manifestPath === undefined || f.manifestPath === f.localPath) {
      continue;
    }
    if (canonicalKeyForLocalPath(input.folderRules, f.localPath) === key) {
      continue; // the folder rule already explains this placement
    }
    const row = input.manifestFiles.find((m) => m.path === key && !m.removedAt);
    if (!row) {
      continue;
    }
    if (row.bindings?.[input.machineId]?.path === f.localPath) {
      continue; // cloud already agrees
    }
    healedRows.set(key, {
      ...row,
      version: Math.max(version, row.version + 1),
      bindings: {
        ...row.bindings,
        [input.machineId]: { path: f.localPath, boundAt: input.nowIso },
      },
    });
    version = Math.max(version, row.version + 1) + 1;
  }
  return { healedRows };
}
