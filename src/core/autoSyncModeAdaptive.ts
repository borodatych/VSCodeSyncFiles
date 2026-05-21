/**
 * F5 — adaptive autoSyncMode: «check-only днём, full ночью».
 *
 * The base `autoSyncMode` setting stays the user's intent. When the
 * optional `quietHours` window is set AND the current time falls within
 * it, the **effective** mode is upgraded:
 *
 *   user mode:    effective inside quiet hours:
 *   ----------    ------------------------------
 *   off           off           (always respect explicit off)
 *   check-only    full          (no one's looking — be helpful)
 *   full          full          (no change)
 *
 * Outside the window the mode is returned unchanged. If the window is
 * not set or malformed — returns the user mode as-is (no-op).
 *
 * Pure module. Tests exercise the timezone-naive HH:MM math.
 */

import type { AutoSyncMode } from "./autoSyncMode.js";

export interface QuietHoursWindow {
  /** "HH:MM" 24-hour, e.g. "22:00". */
  start?: string;
  /** "HH:MM" 24-hour, e.g. "08:00". May be < start (wrap around midnight). */
  end?: string;
}

/** Parse "HH:MM" to minutes-since-midnight. Returns undefined on malformed input. */
export function parseHmToMinutes(hm: string | undefined): number | undefined {
  if (!hm) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi)) return undefined;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return undefined;
  return h * 60 + mi;
}

/** True if `now` falls into a possibly-wrapping window [start, end). */
export function isInsideQuietHours(
  now: Date,
  window: QuietHoursWindow,
): boolean {
  const s = parseHmToMinutes(window.start);
  const e = parseHmToMinutes(window.end);
  if (s === undefined || e === undefined) return false;
  if (s === e) return false; // empty window
  const cur = now.getHours() * 60 + now.getMinutes();
  if (s < e) {
    return cur >= s && cur < e;
  }
  // wraps over midnight, e.g. 22:00–08:00
  return cur >= s || cur < e;
}

/**
 * Resolve effective auto-sync mode given user setting and quiet hours.
 * `now` defaults to `new Date()` — pass an explicit value in tests.
 */
export function effectiveAutoSyncMode(
  userMode: AutoSyncMode,
  quietHours: QuietHoursWindow | undefined,
  now: Date = new Date(),
): AutoSyncMode {
  if (!quietHours || userMode === "off" || userMode === "full") {
    return userMode;
  }
  return isInsideQuietHours(now, quietHours) ? "full" : userMode;
}
