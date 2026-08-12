/**
 * Mass-change guard — protects users from accidentally pushing a manifest
 * that wipes out a workspace.
 *
 * Trigger conditions (any of):
 *   - More than `absoluteThreshold` files marked `removedAt` in this push.
 *   - More than `percentThreshold`% of currently-active files removed.
 *
 * Pure: caller compares two manifests (the previous and the new outgoing one)
 * and gets a `MassChangeReport` to surface in a confirmation modal. No I/O.
 */

import type { CloudManifest, ManifestFile } from "./cloudLayout.js";

export interface MassChangeOptions {
  /** Absolute number of new tombstones that triggers the guard. Default 25. */
  absoluteThreshold?: number;
  /** Share of active files (0..1) that triggers the guard. Default 0.5. */
  percentThreshold?: number;
}

export interface MassChangeReport {
  /** True when the new manifest crosses one of the thresholds. */
  triggered: boolean;
  /** Newly tombstoned (removedAt set) files — paths only. */
  newlyRemoved: string[];
  /** Count of active (non-removed) files in the previous manifest. */
  previousActiveCount: number;
  /** Reason (only present when triggered). */
  reason?: "absolute" | "percent";
}

export const DEFAULT_ABSOLUTE_THRESHOLD = 25;
export const DEFAULT_PERCENT_THRESHOLD = 0.5;

function activePaths(files: readonly ManifestFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (!f.removedAt) out.add(f.path);
  }
  return out;
}

/**
 * Compare `prev` and `next` manifests, return a guard report.
 * Removal = path that was active in `prev` and is either tombstoned (removedAt
 * set) in `next` or absent from `next.files` entirely. A tombstone with a live
 * heir in `next` — an active row whose `renamedFrom` points at it, or one
 * carrying the same `linkId` — is a canonical rename, not a removal: without
 * this every folder rename of 25+ files trips the "mass deletion" modal.
 */
export function detectMassChange(
  prev: CloudManifest | undefined,
  next: CloudManifest,
  opts: MassChangeOptions = {},
): MassChangeReport {
  const absoluteThreshold = opts.absoluteThreshold ?? DEFAULT_ABSOLUTE_THRESHOLD;
  const percentThreshold = opts.percentThreshold ?? DEFAULT_PERCENT_THRESHOLD;

  if (!prev) {
    return { triggered: false, newlyRemoved: [], previousActiveCount: 0 };
  }
  const prevActive = activePaths(prev.files);
  const nextActive = activePaths(next.files);
  const renamedAway = new Set<string>();
  const activeLinkIds = new Set<string>();
  for (const f of next.files) {
    if (f.removedAt) continue;
    if (f.renamedFrom) renamedAway.add(f.renamedFrom);
    if (f.linkId !== undefined) activeLinkIds.add(f.linkId);
  }
  const prevLinkIdByPath = new Map<string, string>();
  for (const f of prev.files) {
    if (!f.removedAt && f.linkId !== undefined) prevLinkIdByPath.set(f.path, f.linkId);
  }
  const movedByLinkId = (p: string): boolean => {
    const id = prevLinkIdByPath.get(p);
    return id !== undefined && activeLinkIds.has(id);
  };
  const newlyRemoved: string[] = [];
  for (const p of prevActive) {
    if (!nextActive.has(p) && !renamedAway.has(p) && !movedByLinkId(p)) newlyRemoved.push(p);
  }
  newlyRemoved.sort();

  const previousActiveCount = prevActive.size;
  if (newlyRemoved.length === 0) {
    return { triggered: false, newlyRemoved, previousActiveCount };
  }
  if (newlyRemoved.length >= absoluteThreshold) {
    return {
      triggered: true,
      newlyRemoved,
      previousActiveCount,
      reason: "absolute",
    };
  }
  if (
    previousActiveCount > 0 &&
    newlyRemoved.length / previousActiveCount >= percentThreshold
  ) {
    return {
      triggered: true,
      newlyRemoved,
      previousActiveCount,
      reason: "percent",
    };
  }
  return { triggered: false, newlyRemoved, previousActiveCount };
}

/** Human-readable label for the confirmation modal. */
export function describeMassChange(report: MassChangeReport): string {
  if (!report.triggered) return "";
  const n = report.newlyRemoved.length;
  if (report.reason === "percent") {
    const pct = Math.round((n / Math.max(1, report.previousActiveCount)) * 100);
    return `Этот push удалит ${String(n)} файлов (${String(pct)}% от ${String(report.previousActiveCount)}). Создать snapshot перед push?`;
  }
  return `Этот push удалит ${String(n)} файлов в облаке. Создать snapshot перед push?`;
}
