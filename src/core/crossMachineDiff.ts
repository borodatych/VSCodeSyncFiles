/**
 * v0.16 N05 — pure helper for "what changed on machine X since I last
 * synced?" diff report.
 *
 * Input:
 *   - my last-sync timestamp (from `vscodesync.json` `files[].lastSync`)
 *   - per-file `_meta.json` entries with `machineId` (who pushed) and
 *     `updatedAt` (when)
 *
 * Output: ordered list of files updated by other machines since I last
 * touched them, grouped by who pushed.
 */

export interface CrossMachineMetaRow {
  posixRel: string;
  /** machineId of the pusher (from MetaEntry). */
  pusherMachineId: string;
  /** ISO timestamp when the push happened. */
  updatedAt: string;
  /** Bytes from `_meta.size` when known. */
  bytes?: number;
}

export interface CrossMachineDiffInput {
  myMachineId: string;
  /** My last successful sync iso for the workspace (newest of `files[].lastSync`). */
  mySinceIso?: string;
  /** Newest meta from cloud `_meta.json`. */
  metaRows: readonly CrossMachineMetaRow[];
  /** Optional name map machineId → label. */
  machineLabels?: Record<string, string>;
}

export interface CrossMachineDiffEntry {
  posixRel: string;
  pusherMachineId: string;
  pusherLabel: string;
  updatedAt: string;
  bytes?: number;
}

export interface CrossMachineDiffReport {
  /** Per-other-machine bucket sorted by recency. */
  byMachine: {
    machineId: string;
    machineLabel: string;
    count: number;
    bytes: number;
    entries: CrossMachineDiffEntry[];
  }[];
  /** Flat list, newest first. */
  entries: CrossMachineDiffEntry[];
  /** Files updated AFTER my last sync — the focus of the report. */
  newSinceMine: number;
}

export function buildCrossMachineDiff(input: CrossMachineDiffInput): CrossMachineDiffReport {
  const sinceMs = input.mySinceIso ? Date.parse(input.mySinceIso) : 0;
  const buckets = new Map<string, { count: number; bytes: number; entries: CrossMachineDiffEntry[] }>();
  const flat: CrossMachineDiffEntry[] = [];

  for (const row of input.metaRows) {
    if (row.pusherMachineId === input.myMachineId) continue;
    const tsMs = Date.parse(row.updatedAt);
    if (!Number.isFinite(tsMs)) continue;
    if (sinceMs > 0 && tsMs <= sinceMs) continue;
    const label = input.machineLabels?.[row.pusherMachineId] ?? row.pusherMachineId;
    const entry: CrossMachineDiffEntry = {
      posixRel: row.posixRel,
      pusherMachineId: row.pusherMachineId,
      pusherLabel: label,
      updatedAt: row.updatedAt,
      bytes: row.bytes,
    };
    flat.push(entry);
    const bucket = buckets.get(row.pusherMachineId) ?? { count: 0, bytes: 0, entries: [] };
    bucket.count += 1;
    bucket.bytes += row.bytes ?? 0;
    bucket.entries.push(entry);
    buckets.set(row.pusherMachineId, bucket);
  }
  flat.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const bucket of buckets.values()) {
    bucket.entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const byMachine = [...buckets.entries()]
    .map(([machineId, b]) => ({
      machineId,
      machineLabel: input.machineLabels?.[machineId] ?? machineId,
      count: b.count,
      bytes: b.bytes,
      entries: b.entries,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    byMachine,
    entries: flat,
    newSinceMine: flat.length,
  };
}
