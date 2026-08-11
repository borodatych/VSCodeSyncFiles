/**
 * Pure half of `repairByCloudScan` (extracted verbatim from `syncEngine.ts` —
 * engine line-ceiling offset for Link Bindings): given the cloud folder
 * listing, decide which entries are tracked-file blobs and reconstruct the
 * placeholder `_meta.json`. Listing in, verdict out — no I/O.
 */
import type { MetaJson } from "../cloudLayout.js";

/** Structural subset of the provider listing — keeps the plan layer provider-free. */
interface ListedEntry {
  cloudPath: string;
}

export function planCloudScanRepair(
  root: string,
  listed: readonly ListedEntry[],
  machineId: string,
  nowIso: string,
): { paths: string[]; reconstructedMeta: MetaJson } {
  // Filter to actual blob files (exclude manifest, meta, history, snapshots, gz variants tracked separately)
  const SKIP_PREFIXES = [
    `${root}/.history/`,
    `${root}/.snapshots/`,
  ];
  const SKIP_NAMES = [
    ".vscodesync-workspace.json",
    "_meta.json",
  ];

  const blobs = listed.filter((item) => {
    const name = item.cloudPath.slice(root.length + 1); // relative to workspace root
    if (SKIP_NAMES.includes(name)) return false;
    if (SKIP_PREFIXES.some((pfx) => item.cloudPath.startsWith(pfx))) return false;
    return true;
  });

  // Strip .gz suffix for wire-compressed blobs
  const paths = blobs.map((b) => {
    let p = b.cloudPath.slice(root.length + 1);
    if (p.endsWith(".gz")) {
      p = p.slice(0, -3);
    }
    return p;
  });

  // Reconstruct a minimal _meta.json with placeholders
  const metaFiles: MetaJson["files"] = {};
  for (const p of paths) {
    metaFiles[p] = {
      hash: "",
      etag: "",
      version: 0,
      updatedAt: nowIso,
      machineId,
      wireGzip: blobs.some((b) => b.cloudPath === `${root}/${p}.gz`),
    };
  }
  return { paths, reconstructedMeta: { files: metaFiles } };
}
