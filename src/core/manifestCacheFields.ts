/**
 * Local-cache projections of a cloud manifest (extracted verbatim from
 * `syncEngine.ts` — engine line-ceiling offset for Link Bindings): the
 * `ActiveWorkspaceEntry` fields that mirror manifest state between syncs.
 * Pure: manifest in, cache fields out.
 */
import type { CloudManifest } from "./cloudLayout.js";
import { sharedIgnorePatternsOrEmpty } from "./cloudLayout.js";
import type { ActiveWorkspaceEntry, ManifestMachineCacheEntry } from "./types.js";

export function manifestMachineCache(m: CloudManifest): ManifestMachineCacheEntry[] {
  return m.machines.map((x) => ({
    machineId: x.machineId,
    machineName: x.machineName,
    lastSeen: x.lastSeen,
    status: x.status,
  }));
}

export function entryPatchFromManifest(m: CloudManifest): Pick<
  ActiveWorkspaceEntry,
  "tags" | "gitBranch" | "sharedIgnorePatterns" | "manifestMachines" | "manifestVersionHighWater"
> {
  return {
    tags: m.tags,
    gitBranch: m.gitBranch,
    sharedIgnorePatterns: sharedIgnorePatternsOrEmpty(m),
    manifestMachines: manifestMachineCache(m),
    // Tombstones count too: their versions compete in merges like any row's.
    manifestVersionHighWater: m.files.reduce((max, f) => Math.max(max, f.version), 0),
  };
}
