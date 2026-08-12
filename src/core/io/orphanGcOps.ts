/**
 * Orphan GC I/O (docs/v3/canonicalPaths.md, follow-up): walk the workspace's
 * cloud folder, hand the listing to the pure planner, and — after the caller's
 * explicit confirmation — move the orphans to the provider's trash. Deletion
 * goes strictly through `deleteFile` (contract D11); `purgeFilePermanently`
 * has no business here. Extracted from the engine for its line ceiling.
 */
import type { FileMetadata, ICloudProvider } from "../../providers/cloudProviderTypes.js";
import type { CloudManifest, MetaJson } from "../cloudLayout.js";
import { workspaceRootPath } from "../cloudLayout.js";
import { planOrphanGc, type OrphanGcPlan } from "../plan/planOrphanGc.js";
import { ProviderError } from "../../providers/cloudProviderTypes.js";
import { warnLog } from "../../utils/log.js";

/** Depth cap mirrors the storage-report walker — sync trees are shallow. */
const WALK_MAX_DEPTH = 6;
/** Runaway backstop, far above any real workspace. */
const WALK_MAX_ENTRIES = 100_000;

export const ORPHAN_GC_DEFAULT_MIN_AGE_DAYS = 7;

async function walkWorkspaceFolder(
  provider: ICloudProvider,
  dir: string,
  depth: number,
  out: FileMetadata[],
): Promise<void> {
  if (depth > WALK_MAX_DEPTH || out.length >= WALK_MAX_ENTRIES) {
    return;
  }
  let entries: FileMetadata[];
  try {
    entries = await provider.listFolder(dir);
  } catch {
    return; // a folder that fails to list contributes nothing — scan degrades
  }
  for (const entry of entries) {
    out.push(entry);
    // Providers that do not flag folders leave `isFolder` undefined; a
    // sizeless entry is the walker's traditional folder heuristic.
    if (entry.isFolder === true || (entry.isFolder === undefined && entry.size === undefined)) {
      await walkWorkspaceFolder(provider, entry.cloudPath, depth + 1, out);
    }
  }
}

export interface OrphanScanDeps {
  workspaceId: string;
  provider: ICloudProvider;
  downloadManifest: () => Promise<CloudManifest | null>;
  pullMeta: () => Promise<MetaJson>;
  minAgeMs: number;
}

/** Read-only: list the workspace folder recursively and plan the collection. */
export async function scanWorkspaceOrphans(deps: OrphanScanDeps): Promise<OrphanGcPlan> {
  const manifest = await deps.downloadManifest();
  if (!manifest) {
    throw new Error("manifest missing on cloud");
  }
  const meta = await deps.pullMeta();
  const listed: FileMetadata[] = [];
  await walkWorkspaceFolder(deps.provider, workspaceRootPath(deps.workspaceId), 0, listed);
  return planOrphanGc({
    workspaceCloudRoot: workspaceRootPath(deps.workspaceId),
    listed,
    manifestFiles: manifest.files,
    metaFiles: meta.files,
    nowMs: Date.now(),
    minAgeMs: deps.minAgeMs,
  });
}

export interface OrphanCollectDeps {
  provider: ICloudProvider;
  pullMeta: () => Promise<MetaJson>;
  pushMeta: (meta: MetaJson) => Promise<void>;
}

export interface OrphanCollectResult {
  deletedObjects: number;
  freedBytes: number;
  droppedMetaKeys: number;
}

/**
 * Move the planned orphans to the provider trash and drop their `_meta` rows
 * in one write. Every step is idempotent: NOT_FOUND means another machine (or
 * a re-run) got there first. A fresh `_meta` is pulled right before the write
 * so a row that came alive since the scan is not dropped blindly.
 */
export async function collectWorkspaceOrphans(
  deps: OrphanCollectDeps,
  plan: OrphanGcPlan,
): Promise<OrphanCollectResult> {
  let deletedObjects = 0;
  let freedBytes = 0;
  for (const obj of [...plan.orphanBlobs, ...plan.orphanHistoryFiles]) {
    try {
      await deps.provider.deleteFile(obj.cloudPath);
      deletedObjects += 1;
      freedBytes += obj.size ?? 0;
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        warnLog("orphanGc", `delete failed for ${obj.cloudPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  let droppedMetaKeys = 0;
  if (plan.orphanMetaKeys.length > 0) {
    const meta = await deps.pullMeta();
    const drop = new Set(plan.orphanMetaKeys);
    const kept = Object.fromEntries(Object.entries(meta.files).filter(([key]) => !drop.has(key)));
    droppedMetaKeys = Object.keys(meta.files).length - Object.keys(kept).length;
    if (droppedMetaKeys > 0) {
      await deps.pushMeta({ ...meta, files: kept });
    }
  }
  return { deletedObjects, freedBytes, droppedMetaKeys };
}
