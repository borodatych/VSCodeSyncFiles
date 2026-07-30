/**
 * v0.16 N10 — per-glob sync scheduler.
 *
 * Lets the user say "sync src/** immediately, docs/** nightly, assets/**
 * weekly". The pure planner takes a list of glob rules + a posix-rel file
 * path and decides which window applies.
 *
 * Rules are tested in order — first match wins. Default (no match) is
 * "immediate".
 */

export type SyncWindow = "immediate" | "hourly" | "nightly" | "weekly" | "never";

export interface PerGlobScheduleRule {
  /** Posix-style glob (`*`, `**`, `?` segments). */
  pattern: string;
  window: SyncWindow;
}

export interface PerGlobScheduleConfig {
  rules: readonly PerGlobScheduleRule[];
  /** Window when no rule matches. Default "immediate". */
  defaultWindow?: SyncWindow;
}

/**
 * Minimatch-style: `**` matches across slashes, `*` within a segment.
 *
 * Implementation note (v0.17 A1 clarification): SENTINEL **must** be a
 * non-empty string. `split("")` would split per-codepoint and produce
 * garbage. We use the escape sequence `"\u0001"` (U+0001 is illegal in
 * POSIX paths so it cannot collide with user input) rather than a raw
 * control character so the source stays readable in any editor.
 */
export function matchesGlob(posixRel: string, pattern: string): boolean {
  const SENTINEL = "\u0001";
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, SENTINEL)
    .replace(/\*/g, "[^/]*")
    .split(SENTINEL).join(".*");
  return new RegExp(`^${re}$`).test(posixRel);
}

export function resolveWindowForPath(
  config: PerGlobScheduleConfig,
  posixRel: string,
): SyncWindow {
  for (const rule of config.rules) {
    if (matchesGlob(posixRel, rule.pattern)) return rule.window;
  }
  return config.defaultWindow ?? "immediate";
}

/** Is `window` "due" now given `lastSyncMs`? Pure decision. */
export function isWindowDue(
  window: SyncWindow,
  lastSyncMs: number,
  nowMs: number,
): boolean {
  if (window === "never") return false;
  if (window === "immediate") return true;
  if (lastSyncMs <= 0) return true; // never synced — always due
  const elapsed = nowMs - lastSyncMs;
  switch (window) {
    case "hourly": return elapsed >= 3600_000;
    case "nightly": return elapsed >= 86_400_000;
    case "weekly": return elapsed >= 7 * 86_400_000;
  }
}

/** Group a list of files by their window, useful for batch decisions. */
export function groupFilesByWindow(
  config: PerGlobScheduleConfig,
  files: readonly { posixRel: string; lastSyncMs: number }[],
  nowMs: number,
): Map<SyncWindow, { posixRel: string; due: boolean }[]> {
  const out = new Map<SyncWindow, { posixRel: string; due: boolean }[]>();
  for (const f of files) {
    const w = resolveWindowForPath(config, f.posixRel);
    const due = isWindowDue(w, f.lastSyncMs, nowMs);
    if (!out.has(w)) out.set(w, []);
    out.get(w)!.push({ posixRel: f.posixRel, due });
  }
  return out;
}
