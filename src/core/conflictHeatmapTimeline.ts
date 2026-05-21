/**
 * v0.16 N14 — timeline builder for the conflict heatmap.
 *
 * Bucketise conflict events by day (or any time bucket) so the UI can
 * render a calendar-heatmap (а-la GitHub contributions chart). Pure.
 */

export interface ConflictHeatmapBucket {
  /** ISO date YYYY-MM-DD. */
  dayIso: string;
  /** Number of conflict events that day. */
  count: number;
  /** Top-N files involved that day. */
  topFiles: { posixRel: string; count: number }[];
}

export interface ConflictHeatmapTimelineInput {
  events: readonly { atIso: string; posixRel: string }[];
  /** Window — default last 90 days. */
  fromIso?: string;
  toIso?: string;
  /** Top files per bucket. Default 3. */
  topPerBucket?: number;
}

export interface ConflictHeatmapTimeline {
  buckets: ConflictHeatmapBucket[];
  /** Newest-first peak day (highest count). */
  peak: ConflictHeatmapBucket | null;
  /** Sum across all buckets. */
  total: number;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function buildConflictHeatmapTimeline(
  input: ConflictHeatmapTimelineInput,
): ConflictHeatmapTimeline {
  const topPerBucket = Math.max(1, Math.min(10, input.topPerBucket ?? 3));
  // v0.17 A11 — JSDoc promises "last 90 days" as the default window. Apply
  // it when neither `fromIso` nor `toIso` is supplied (was: accept events
  // from 1970, contradicting documented behaviour).
  const DEFAULT_WINDOW_DAYS = 90;
  const nowMs = Date.now();
  const fromMs = input.fromIso
    ? Date.parse(input.fromIso)
    : input.toIso === undefined
      ? nowMs - DEFAULT_WINDOW_DAYS * 86_400_000
      : 0;
  const toMs = input.toIso ? Date.parse(input.toIso) : Number.POSITIVE_INFINITY;
  const byDay = new Map<string, Map<string, number>>();

  let total = 0;
  for (const ev of input.events) {
    const tsMs = Date.parse(ev.atIso);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < fromMs || tsMs > toMs) continue;
    const day = dayOf(ev.atIso);
    let perFile = byDay.get(day);
    if (!perFile) {
      perFile = new Map();
      byDay.set(day, perFile);
    }
    perFile.set(ev.posixRel, (perFile.get(ev.posixRel) ?? 0) + 1);
    total += 1;
  }

  const buckets: ConflictHeatmapBucket[] = [...byDay.entries()]
    .map(([dayIso, perFile]) => {
      const fileEntries = [...perFile.entries()].map(([posixRel, count]) => ({ posixRel, count }));
      fileEntries.sort((a, b) => b.count - a.count);
      const dayTotal = fileEntries.reduce((sum, f) => sum + f.count, 0);
      return {
        dayIso,
        count: dayTotal,
        topFiles: fileEntries.slice(0, topPerBucket),
      };
    })
    .sort((a, b) => a.dayIso.localeCompare(b.dayIso));

  const peak = buckets.length === 0
    ? null
    : buckets.reduce<ConflictHeatmapBucket | null>((max, b) => (max === null || b.count > max.count ? b : max), null);

  return { buckets, peak, total };
}
