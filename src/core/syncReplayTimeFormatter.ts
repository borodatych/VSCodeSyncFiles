/**
 * v3.N — pure time-formatting helpers for the sync replay viewer rows.
 *
 * The viewer needs three formats:
 *   - Absolute time: "14:23:05.123" / "2026-05-08 14:23:05" depending on
 *     scope (intra-day or cross-day window).
 *   - Relative time: "+0.4s" / "+1m 12s" since the previous event, so the
 *     viewer can show event cadence at a glance.
 *   - Duration: "0.4s" / "1m 12s" for a span between two events.
 *
 * No `vscode` import. No locale dependency — output is ASCII for
 * deterministic snapshot tests.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Render a single event's absolute time. When the surrounding window is
 * known to span more than 24h, include the date; otherwise show
 * HH:MM:SS.mmm only. */
export interface FormatAbsoluteOptions {
  /** ms timestamp of the earliest event in the window. */
  windowStartMs: number;
  /** ms timestamp of the latest event in the window. */
  windowEndMs: number;
}

export function formatAbsoluteTime(
  tsMs: number,
  options: FormatAbsoluteOptions,
): string {
  const span = options.windowEndMs - options.windowStartMs;
  const d = new Date(tsMs);
  const hms = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  if (span >= DAY_MS) {
    const date = `${String(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    return `${date} ${hms}`;
  }
  return `${hms}.${ms}`;
}

/** Render a relative time: "+0.4s" / "+12s" / "+1m 12s" / "+2h 5m".
 * Always carries the leading "+" so the viewer column is visually
 * stable regardless of magnitude. */
export function formatRelativeTime(deltaMs: number): string {
  if (deltaMs < 0) return formatRelativeTime(0);
  if (deltaMs < 1000) {
    const tenths = Math.round(deltaMs / 100);
    if (tenths === 0) return "+0s";
    return `+0.${String(tenths)}s`;
  }
  if (deltaMs < 60_000) {
    return `+${String(Math.round(deltaMs / 1000))}s`;
  }
  if (deltaMs < HOUR_MS) {
    const m = Math.floor(deltaMs / 60_000);
    const s = Math.floor((deltaMs % 60_000) / 1000);
    return s > 0 ? `+${String(m)}m ${String(s)}s` : `+${String(m)}m`;
  }
  const h = Math.floor(deltaMs / HOUR_MS);
  const m = Math.floor((deltaMs % HOUR_MS) / 60_000);
  return m > 0 ? `+${String(h)}h ${String(m)}m` : `+${String(h)}h`;
}

/** Render a duration without the leading "+", suitable for "Total span:
 * 1m 12s" footers. Negative input clamps to "0s". */
export function formatDuration(deltaMs: number): string {
  return formatRelativeTime(deltaMs).replace(/^\+/, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
