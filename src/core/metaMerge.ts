import type { MetaEntry, MetaJson } from "./cloudLayout.js";
import { warnLog } from "../utils/log.js";

function pickNewer(a: MetaEntry, b: MetaEntry): MetaEntry {
  if (a.version > b.version) {
    return a;
  }
  if (b.version > a.version) {
    return b;
  }
  if (a.updatedAt === b.updatedAt && a.hash !== b.hash) {
    // Identical (version, updatedAt) yet different hash — concurrent writes
    // produced ambiguous state. We still pick `a` (local) for stability, but
    // surface it so support bundles capture the divergence.
    warnLog(
      "metaMerge",
      `pickNewer tie-break: version=${String(a.version)} updatedAt=${a.updatedAt} ` +
        `hashA=${a.hash.slice(0, 8)} hashB=${b.hash.slice(0, 8)} machineA=${a.machineId} machineB=${b.machineId}`,
    );
  }
  return a.updatedAt >= b.updatedAt ? a : b;
}

/** Слияние `_meta` при гонке (412): по version / updatedAt. */
export function mergeMetaEntries(local: MetaJson, remote: MetaJson): MetaJson {
  const files: Record<string, MetaEntry> = {};
  for (const [p, e] of Object.entries(remote.files)) {
    if (e !== undefined) {
      files[p] = e;
    }
  }
  for (const [p, entry] of Object.entries(local.files)) {
    if (entry === undefined) {
      continue;
    }
    const remoteEntry = remote.files[p];
    if (remoteEntry === undefined) {
      files[p] = entry;
    } else {
      files[p] = pickNewer(entry, remoteEntry);
    }
  }
  return { files };
}
