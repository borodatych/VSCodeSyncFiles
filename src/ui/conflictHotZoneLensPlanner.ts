/**
 * Pure planner for the "conflict hot-zone" CodeLens.
 *
 * Given the document's relative path, the document's line count, and the list
 * of hot zones from `buildHotZones`, decides which lens entries to surface
 * and on which line each one anchors. Clamped to the document's line range so
 * lenses never point past the end of the file.
 */
import type { HotZone } from "../core/conflictHeatmapStore.js";

export interface HotZoneLensPlan {
  /** 0-based line where the lens anchors. */
  line: number;
  /** Original 1-based start line from the hot zone (for the lens label). */
  zoneStart: number;
  /** Original 1-based end line from the hot zone. */
  zoneEnd: number;
  /** Conflict count clustered into this zone. */
  count: number;
}

export function planHotZoneLenses(
  hotZones: readonly HotZone[],
  docRelPath: string,
  docLineCount: number,
): HotZoneLensPlan[] {
  if (docLineCount <= 0 || !docRelPath) return [];
  const out: HotZoneLensPlan[] = [];
  for (const zone of hotZones) {
    if (zone.relPath !== docRelPath) continue;
    if (zone.count <= 0) continue;
    // 1-based → 0-based; clamp into the document.
    const zeroBased = Math.max(zone.startLine - 1, 0);
    const line = Math.min(zeroBased, docLineCount - 1);
    out.push({
      line,
      zoneStart: zone.startLine,
      zoneEnd: zone.endLine,
      count: zone.count,
    });
  }
  // Stable order: top-to-bottom in the file.
  out.sort((a, b) => a.line - b.line);
  return out;
}

export function formatHotZoneLensTitle(plan: HotZoneLensPlan): string {
  const span =
    plan.zoneStart === plan.zoneEnd
      ? `line ${String(plan.zoneStart)}`
      : `lines ${String(plan.zoneStart)}–${String(plan.zoneEnd)}`;
  return `$(flame) Conflict hot zone · ${String(plan.count)}× resolved on ${span}`;
}
