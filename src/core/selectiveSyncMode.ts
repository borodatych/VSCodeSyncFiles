/**
 * Selective sync — WHICH of the tracked files this machine actually syncs.
 *
 * The product already had a pattern source: `.vscodesync-ignore` plus the
 * manifest's shared patterns plus this machine's local ones, combined by
 * `buildCombinedIgnoreRules` into gitignore-style rules. What it lacked was
 * (a) an inverted reading — "sync ONLY what matches" — and (b) any effect
 * during sync itself: the rules gated adding files and the manual push guard,
 * and the sync loop never consulted them, so a tracked file that later matched
 * a pattern kept syncing.
 *
 * This module supplies the missing verdict, deliberately over the SAME rules
 * and the SAME matcher. A second pattern file with its own glob dialect would
 * be a second answer to one question — the day they disagree, nobody can say
 * why a file is not syncing.
 *
 * Contract, mirroring `syncScopes`: a file filtered out here stops syncing ON
 * THIS MACHINE. It is not untracked, not tombstoned, and nothing is removed
 * from the cloud — other machines keep syncing it.
 */
import { isIgnoredByRules, type IgnoreRule } from "../utils/ignoreMatch.js";

export type SelectiveSyncMode = "all-tracked" | "exclude-list" | "include-list";

export function parseSelectiveSyncMode(raw: string | undefined): SelectiveSyncMode {
  return raw === "include-list" || raw === "exclude-list" ? raw : "all-tracked";
}

/**
 * Should this machine sync `posixRel` right now?
 *
 * `all-tracked` keeps the historical behaviour — the patterns still guard
 * adding and manual pushes, but they do not silently stop an already-synced
 * file. Only an explicit mode switch gives them that power.
 */
export function shouldSyncUnderMode(
  posixRel: string,
  rules: readonly IgnoreRule[],
  mode: SelectiveSyncMode,
): boolean {
  if (mode === "all-tracked" || rules.length === 0) {
    return true;
  }
  const matched = isIgnoredByRules(posixRel, rules as IgnoreRule[]);
  return mode === "include-list" ? matched : !matched;
}

export interface SelectiveSyncImpact {
  /** Syncing now, would stop under the new mode. */
  wouldStop: string[];
  /** Not syncing now, would start. */
  wouldStart: string[];
  unchangedCount: number;
}

/**
 * What changes if the mode flips. Computed with the runtime verdict above, so
 * the preview cannot disagree with what the engine will actually do.
 */
export function summariseModeSwitch(input: {
  trackedRelPaths: readonly string[];
  rules: readonly IgnoreRule[];
  prevMode: SelectiveSyncMode;
  nextMode: SelectiveSyncMode;
}): SelectiveSyncImpact {
  const wouldStop: string[] = [];
  const wouldStart: string[] = [];
  let unchangedCount = 0;
  for (const rel of input.trackedRelPaths) {
    const before = shouldSyncUnderMode(rel, input.rules, input.prevMode);
    const after = shouldSyncUnderMode(rel, input.rules, input.nextMode);
    if (before === after) unchangedCount += 1;
    else if (before) wouldStop.push(rel);
    else wouldStart.push(rel);
  }
  return { wouldStop, wouldStart, unchangedCount };
}

export type SelectiveSyncSeverity = "noop" | "info" | "warn" | "danger";

/** Ten files silently leaving sync deserves a different dialog than one. */
export function scoreModeSwitch(impact: SelectiveSyncImpact): SelectiveSyncSeverity {
  if (impact.wouldStop.length === 0 && impact.wouldStart.length === 0) return "noop";
  if (impact.wouldStop.length >= 10) return "danger";
  if (impact.wouldStop.length > 0) return "warn";
  return "info";
}
