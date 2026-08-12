/**
 * `.history/` reading across a rename chain (docs/v3/canonicalPaths.md).
 * Snapshots live under the canonical key that was current when they were
 * taken; a renamed file's history is the union of its chain directories.
 * Extracted from the engine for its line ceiling.
 */
import type { ICloudProvider, FileMetadata } from "../../providers/cloudProviderTypes.js";
import { historyDirForFile } from "../cloudLayout.js";

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Union of the chain keys' history listings, newest first. Snapshot names
 * start with an ISO stamp, so one lexicographic sort orders the merged set
 * globally. A directory that fails to list (never renamed there, provider
 * hiccup, moved away by moveHistoryDirs) contributes nothing — history is a
 * convenience trail, not a correctness surface.
 */
export async function listHistoryAcrossKeys(
  provider: ICloudProvider,
  workspaceId: string,
  chainKeys: readonly string[],
): Promise<FileMetadata[]> {
  const merged: FileMetadata[] = [];
  const seen = new Set<string>();
  for (const key of chainKeys) {
    let items: FileMetadata[];
    try {
      items = await provider.listFolder(historyDirForFile(workspaceId, key));
    } catch {
      continue;
    }
    for (const item of items) {
      if (!seen.has(item.cloudPath)) {
        seen.add(item.cloudPath);
        merged.push(item);
      }
    }
  }
  return merged.sort((a, b) => baseName(b.cloudPath).localeCompare(baseName(a.cloudPath)));
}

/** True when `historyCloudPath` lies under one of the chain keys' history dirs. */
export function historyPathOwnedByChain(
  workspaceId: string,
  chainKeys: readonly string[],
  historyCloudPath: string,
): boolean {
  const norm = historyCloudPath.replace(/\/$/, "");
  return chainKeys.some((k) => norm.startsWith(`${historyDirForFile(workspaceId, k)}/`));
}
