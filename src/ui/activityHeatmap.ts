/**
 * Pure helper: bucket Activity events into a 7×24 hour-of-week heatmap.
 *
 * Rows = day of week (0 = Sun … 6 = Sat). Cols = hour of day (0..23).
 * Each cell holds a count of events whose `at` timestamp falls into that hour.
 *
 * vscode-free so it's covered by unit tests; the dashboard webview consumes
 * the resulting `number[7][24]` matrix and renders CSS-grid cells.
 */
import type { ActivityEvent } from "../core/activityLog.js";

export type HeatmapMatrix = number[][]; // 7 × 24

export interface BucketOptions {
  /** Local time when computing day-of-week / hour-of-day. Defaults to local. */
  timezone?: "local" | "utc";
}

export function emptyHeatmap(): HeatmapMatrix {
  const out: HeatmapMatrix = [];
  for (let d = 0; d < 7; d++) {
    out.push(new Array<number>(24).fill(0));
  }
  return out;
}

export function bucketActivity(
  events: readonly ActivityEvent[],
  opts: BucketOptions = {},
): HeatmapMatrix {
  const m = emptyHeatmap();
  const useUtc = opts.timezone === "utc";
  for (const ev of events) {
    const t = Date.parse(ev.at);
    if (Number.isNaN(t)) continue;
    const d = new Date(t);
    const dow = useUtc ? d.getUTCDay() : d.getDay();
    const hour = useUtc ? d.getUTCHours() : d.getHours();
    if (dow >= 0 && dow < 7 && hour >= 0 && hour < 24) {
      m[dow][hour] += 1;
    }
  }
  return m;
}

export interface HeatmapStats {
  total: number;
  peakValue: number;
  /** Day-of-week (0..6) and hour (0..23) of the peak cell; undefined for empty matrix. */
  peakAt?: { dow: number; hour: number };
}

export function describeHeatmap(m: HeatmapMatrix): HeatmapStats {
  let total = 0;
  let peakValue = 0;
  let peakAt: { dow: number; hour: number } | undefined;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const v = m[d][h];
      total += v;
      if (v > peakValue) {
        peakValue = v;
        peakAt = { dow: d, hour: h };
      }
    }
  }
  return { total, peakValue, peakAt };
}
