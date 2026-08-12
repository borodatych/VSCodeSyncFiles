/**
 * Folder-binding write path (docs/v2/linkBindings.md), extracted from
 * `syncEngine.ts` for its size gate.
 *
 * Two steps that must not drift apart: publish this machine's folder rule, and
 * re-place tracked rows that are still stranded at the canonical placement
 * while their bytes actually live under the local prefix. The engine passes
 * its I/O in as callbacks, so the flow reads top-to-bottom without the class.
 */
import type { CloudManifest, MetaJson } from "./cloudLayout.js";
import { manifestKeyOf } from "./trackedPathResolver.js";
import type { WorkspaceConfig } from "./types.js";

export interface PublishFolderRuleInput {
  manifest: CloudManifest;
  machineId: string;
  canonPrefix: string;
  localDirRel: string;
  nowIso: string;
  touchMachines: (machines: CloudManifest["machines"], now: string) => CloudManifest["machines"];
}

/** The manifest as it should be published once the rule is added. Pure. */
export function manifestWithFolderRule(input: PublishFolderRuleInput): CloudManifest {
  const machineRules = {
    ...input.manifest.folderBindings?.[input.machineId],
    [input.canonPrefix]: { path: input.localDirRel, boundAt: input.nowIso },
  };
  return {
    ...input.manifest,
    updatedAt: input.nowIso,
    machines: input.touchMachines(input.manifest.machines, input.nowIso),
    folderBindings: { ...input.manifest.folderBindings, [input.machineId]: machineRules },
  };
}

/**
 * The manifest with one row's human label changed. A user edit fights real
 * edits in 412-merges, so the row takes a Lamport bump. Pure; throws when the
 * row is gone or tombstoned — renaming a deleted entry is a no-op the caller
 * should surface, not swallow.
 */
export function manifestWithLinkName(input: {
  manifest: CloudManifest;
  manifestKey: string;
  linkName: string;
  nowIso: string;
  nextVersion: number;
  touchMachines: (machines: CloudManifest["machines"], now: string) => CloudManifest["machines"];
}): CloudManifest {
  const row = input.manifest.files.find((f) => f.path === input.manifestKey && !f.removedAt);
  if (!row) {
    throw new Error(`manifest row not found: ${input.manifestKey}`);
  }
  const updated = {
    ...row,
    linkName: input.linkName,
    version: Math.max(input.nextVersion, row.version + 1),
  };
  return {
    ...input.manifest,
    updatedAt: input.nowIso,
    machines: input.touchMachines(input.manifest.machines, input.nowIso),
    files: input.manifest.files.map((f) => (f === row ? updated : f)),
  };
}

/**
 * A local move of a BOUND file is a rebind: only this machine's placement in
 * the row's `bindings` changes — no blob copy, no tombstone, no `_meta` move.
 * User action, so the row takes a Lamport bump. Pure; `null` when the row is
 * gone or tombstoned (nothing to update in the cloud).
 */
export function manifestWithRebinding(input: {
  manifest: CloudManifest;
  manifestKey: string;
  machineId: string;
  /** The new machine-local placement. */
  localRel: string;
  nowIso: string;
  nextVersion: number;
  touchMachines: (machines: CloudManifest["machines"], now: string) => CloudManifest["machines"];
}): CloudManifest | null {
  const row = input.manifest.files.find((f) => f.path === input.manifestKey && !f.removedAt);
  if (!row) {
    return null;
  }
  const updated = {
    ...row,
    version: Math.max(input.nextVersion, row.version + 1),
    bindings: {
      ...row.bindings,
      [input.machineId]: { path: input.localRel, boundAt: input.nowIso },
    },
  };
  return {
    ...input.manifest,
    updatedAt: input.nowIso,
    machines: input.touchMachines(input.manifest.machines, input.nowIso),
    files: input.manifest.files.map((f) => (f === row ? updated : f)),
  };
}

/**
 * Unbinding convention (docs/v2/linkBindings.md): a machine letting go of a
 * bound row writes the CANONICAL path back into its bindings key — never a
 * deletion, which union-merge would resurrect. Rows already reading "not bound
 * here" (or tombstoned, or without this machine's key) pass through untouched;
 * returns `null` when nothing changes, so the caller can skip the PUT. Pure.
 */
export function manifestWithBindingsReset(input: {
  manifest: CloudManifest;
  machineId: string;
  /** Canonical keys whose binding this machine releases. */
  keys: readonly string[];
  nowIso: string;
  nextVersion: number;
  touchMachines: (machines: CloudManifest["machines"], now: string) => CloudManifest["machines"];
}): CloudManifest | null {
  const keys = new Set(input.keys);
  const files = input.manifest.files.map((row) => {
    const bound = row.bindings?.[input.machineId];
    if (!keys.has(row.path) || row.removedAt || bound === undefined || bound.path === row.path) {
      return row;
    }
    return {
      ...row,
      version: Math.max(input.nextVersion, row.version + 1),
      bindings: {
        ...row.bindings,
        [input.machineId]: { path: row.path, boundAt: input.nowIso },
      },
    };
  });
  if (files.every((f, i) => f === input.manifest.files[i])) {
    return null;
  }
  return {
    ...input.manifest,
    updatedAt: input.nowIso,
    machines: input.touchMachines(input.manifest.machines, input.nowIso),
    files,
  };
}

/**
 * Tombstone one canonical key in a manifest copy, in place: bump an existing
 * row or push a fresh tombstone when the row is already gone. Shared by
 * `removeTrackedFiles` and `untrackFileTombstoneOnly`, which differ only in
 * whether the blob is deleted too.
 */
export function tombstoneManifestKey(
  files: CloudManifest["files"],
  key: string,
  nowIso: string,
  nextVersion: number,
): void {
  const ix = files.findIndex((f) => f.path === key);
  if (ix >= 0) {
    const prev = files[ix];
    files[ix] = { ...prev, removedAt: nowIso, version: Math.max(nextVersion, prev.version + 1) };
    return;
  }
  files.push({
    path: key,
    addedAt: nowIso,
    version: nextVersion,
    hasSyncignoreMarkers: false,
    removedAt: nowIso,
  });
}

export interface ReplaceStrandedRowsDeps {
  cfg: WorkspaceConfig;
  workspaceId: string;
  canonPrefix: string;
  localDirRel: string;
  meta: MetaJson;
  /** Absolute path of a tracked posix path on this machine. */
  localAbs: (posixRel: string) => string;
  fileExists: (abs: string) => Promise<boolean>;
  /** Canonical hash of on-disk bytes, keyed by the manifest key; "" when unreadable. */
  hashTracked: (abs: string, manifestKey: string) => Promise<string>;
}

/**
 * Move rows that point at `canonPrefix/**` to `localDirRel/**` when — and only
 * when — the canonical placement is empty and the local one holds the bytes.
 * Mutates `deps.cfg.files` in place (the caller owns and saves it) and returns
 * how many rows moved.
 */
export async function replaceStrandedRows(deps: ReplaceStrandedRowsDeps): Promise<number> {
  let rebound = 0;
  for (let i = 0; i < deps.cfg.files.length; i++) {
    const f = deps.cfg.files[i];
    if (f.workspaceId !== deps.workspaceId) continue;
    const fKey = manifestKeyOf(f);
    if (!fKey.startsWith(`${deps.canonPrefix}/`) || f.localPath !== fKey) continue;
    const placement = `${deps.localDirRel}/${fKey.slice(deps.canonPrefix.length + 1)}`;
    if (await deps.fileExists(deps.localAbs(f.localPath))) continue;
    if (!(await deps.fileExists(deps.localAbs(placement)))) continue;
    const hash = await deps.hashTracked(deps.localAbs(placement), fKey).catch(() => "");
    const matches = hash !== "" && hash === deps.meta.files[fKey]?.hash;
    deps.cfg.files[i] = {
      ...f,
      localPath: placement,
      manifestPath: fKey,
      localHash: matches ? hash : "",
      syncStatus: matches ? "ok" : "cloud_newer",
    };
    rebound += 1;
  }
  return rebound;
}
