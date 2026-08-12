/**
 * Health-check driven manifest maintenance ops, extracted from `syncEngine.ts`
 * for its line ceiling: stale soft-lock listing/clearing and duplicate-linkId
 * listing/repair. The pure transforms live in softLockAdmin.ts and
 * linkIdentity.ts; this module owns the workspace plumbing (entry lookup,
 * manifest fetch, PUT), injected as closures by the engine.
 */
import type { CloudManifest, ManifestFile } from "./cloudLayout.js";
import {
  findDuplicateLinkIds,
  repairDuplicateLinkIds,
  type DuplicateLinkIdGroup,
} from "./linkIdentity.js";
import { findStaleLocks } from "./softLockAdmin.js";
import type { ActiveWorkspaceEntry } from "./types.js";

export interface ManifestHealthDeps {
  findEntry: () => Promise<ActiveWorkspaceEntry | undefined>;
  downloadManifest: (ifNoneMatch: string | undefined) => Promise<CloudManifest | null>;
  putManifest: (manifest: CloudManifest, ifMatch: string | undefined) => Promise<void>;
  currentEtag: (fallback: string | undefined) => Promise<string | undefined>;
  touchMachines: (machines: CloudManifest["machines"], now: string) => CloudManifest["machines"];
}

async function workspaceManifest(
  deps: ManifestHealthDeps,
): Promise<{ entry: ActiveWorkspaceEntry; manifest: CloudManifest } | null> {
  const entry = await deps.findEntry();
  if (!entry) {
    return null;
  }
  const manifest = await deps.downloadManifest(entry.manifestEtag);
  return manifest ? { entry, manifest } : null;
}

export interface StaleLockRow {
  path: string;
  editingBy: string;
  editingSince: string;
  ageHours: number;
}

/** Manifest paths with an abandoned soft lock. Read-only. */
export async function listStaleManifestLocks(
  deps: ManifestHealthDeps,
  staleMs: number,
): Promise<StaleLockRow[]> {
  const ctx = await workspaceManifest(deps);
  if (!ctx) {
    return [];
  }
  // One definition of "stale", shared with the clearing path below.
  return findStaleLocks(ctx.manifest, staleMs, Date.now()).map((r) => ({
    path: r.posixRel,
    editingBy: r.machineId,
    editingSince: r.editingSince,
    ageHours: r.ageMs / 3600_000,
  }));
}

/**
 * Clear soft locks whose `editingSince` is older than `staleMs`. Clearing
 * someone else's abandoned lock *is* an edit to the row, so the version bumps
 * here — unlike taking or dropping your own lock. Returns the number of files
 * updated.
 */
export async function clearStaleManifestLocks(
  deps: ManifestHealthDeps,
  staleMs: number,
): Promise<number> {
  const ctx = await workspaceManifest(deps);
  if (!ctx) {
    throw new Error("workspace not active or manifest missing");
  }
  const nowIso = new Date().toISOString();
  const stale = new Set(findStaleLocks(ctx.manifest, staleMs, Date.now()).map((r) => r.posixRel));
  if (stale.size === 0) {
    return 0;
  }
  const files: ManifestFile[] = ctx.manifest.files.map((f) => {
    if (!stale.has(f.path)) {
      return f;
    }
    const rest = { ...f };
    delete rest.editingBy;
    delete rest.editingSince;
    return { ...rest, version: f.version + 1 };
  });
  await deps.putManifest(
    {
      ...ctx.manifest,
      files,
      updatedAt: nowIso,
      machines: deps.touchMachines(ctx.manifest.machines, nowIso),
    },
    await deps.currentEtag(ctx.entry.manifestEtag),
  );
  return stale.size;
}

/** Live rows sharing one linkId — read-only, same manifest fetch as Health Check. */
export async function listWorkspaceDuplicateLinkIds(deps: ManifestHealthDeps): Promise<DuplicateLinkIdGroup[]> {
  const ctx = await workspaceManifest(deps);
  return ctx ? findDuplicateLinkIds(ctx.manifest.files) : [];
}

/**
 * One-click repair: the newest carrier keeps the identity, older ones are
 * tombstoned with their bindings folded in. The 412-merge path auto-repairs
 * races it participates in; this covers duplicates surfaced by Health Check
 * when no write is in flight. Returns the number of repaired groups.
 */
export async function repairWorkspaceDuplicateLinkIdGroups(deps: ManifestHealthDeps): Promise<number> {
  const ctx = await workspaceManifest(deps);
  if (!ctx) {
    throw new Error("workspace not active or manifest missing");
  }
  const groups = findDuplicateLinkIds(ctx.manifest.files).length;
  if (groups === 0) {
    return 0;
  }
  const repaired = repairDuplicateLinkIds(ctx.manifest, new Date().toISOString());
  await deps.putManifest(repaired, await deps.currentEtag(ctx.entry.manifestEtag));
  return groups;
}
