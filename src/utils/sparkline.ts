/**
 * Render an N-point sparkline from a numeric series, using the 8 Unicode
 * block-elements ▁▂▃▄▅▆▇█. No graphics, fits inside a Status Bar string.
 *
 * Buckets are scaled relative to the max in the input — a flat zero series
 * yields all-low blocks, a single spike grows visible. Empty input yields
 * an empty string (caller decides whether to show or not).
 *
 * vscode-free: covered by unit tests directly.
 */

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  let max = 0;
  for (const v of values) {
    if (v > max) max = v;
  }
  if (max === 0) return BLOCKS[0].repeat(values.length);
  let out = "";
  for (const v of values) {
    const norm = Math.max(0, Math.min(1, v / max));
    const idx = Math.min(BLOCKS.length - 1, Math.floor(norm * BLOCKS.length));
    out += BLOCKS[idx];
  }
  return out;
}

/**
 * Bucket a stream of timestamps (ISO-8601 or epoch-ms) into N hourly buckets
 * ending at `endMs`. Bucket 0 is the oldest hour, bucket N-1 is the most
 * recent. Out-of-window timestamps are dropped silently.
 */
export function bucketHourly(
  timestamps: readonly (string | number)[],
  endMs: number,
  hours: number,
): number[] {
  const buckets = new Array<number>(hours).fill(0);
  const startMs = endMs - hours * 3600_000;
  for (const t of timestamps) {
    const ms = typeof t === "number" ? t : Date.parse(t);
    if (Number.isNaN(ms)) continue;
    if (ms < startMs || ms > endMs) continue;
    const idx = Math.min(hours - 1, Math.floor((ms - startMs) / 3600_000));
    if (idx >= 0 && idx < hours) buckets[idx]++;
  }
  return buckets;
}
