/**
 * v3.A — pure template renderer for `.vscodesync-include` plus the
 * before/after impact summary used by the diff-preview that surfaces when
 * the user switches mode. The UI layer (`vscodesync.selectiveSyncEditList`)
 * writes the template via `vscode.workspace.fs.writeFile` and pipes the
 * impact summary through a `showWarningMessage` modal.
 *
 * No `vscode` import. Caller passes the current tracked-file set explicitly.
 */

import {
  evaluateSelectiveSync,
  type SelectiveSyncMode,
} from "./selectiveSyncFilter.js";

/** Render a starter `.vscodesync-include` template with mode-aware comments. */
export function renderSelectiveSyncIncludeTemplate(mode: SelectiveSyncMode): string {
  const header =
    mode === "exclude-list"
      ? "# .vscodesync-include — patterns listed here are EXCLUDED from sync."
      : "# .vscodesync-include — only files matching one of these patterns sync.";
  return [
    header,
    "# Pattern syntax: gitignore-style globs.",
    "#   *           any segment except /",
    "#   **          any number of segments",
    "#   trailing /  directory pattern (matches everything beneath)",
    "# Comments start with # and blank lines are ignored.",
    "",
    "# Examples (uncomment as needed):",
    "# src/**",
    "# docs/**",
    "# *.md",
    "# !secret.txt        # negation is NOT supported",
    "",
  ].join("\n");
}

export interface SelectiveSyncImpact {
  /** Files currently tracked & syncing that would stop syncing under
   * `nextMode` + `nextPatterns`. */
  wouldStop: string[];
  /** Files currently tracked but NOT syncing that would resume syncing. */
  wouldStart: string[];
  /** Files where the verdict does not change. */
  unchangedCount: number;
}

export interface SelectiveSyncImpactInput {
  trackedRelPaths: string[];
  prevMode: SelectiveSyncMode;
  prevPatterns: string[];
  nextMode: SelectiveSyncMode;
  nextPatterns: string[];
}

/** Compute which tracked paths flip in/out of "should sync" between two
 * (mode + pattern set) snapshots. Result drives the warning modal: a
 * non-empty `wouldStop[]` ought to require explicit confirmation. */
export function summariseSelectiveSyncImpact(input: SelectiveSyncImpactInput): SelectiveSyncImpact {
  const wouldStop: string[] = [];
  const wouldStart: string[] = [];
  let unchanged = 0;
  for (const rel of input.trackedRelPaths) {
    const before = evaluateSelectiveSync(rel, {
      mode: input.prevMode,
      patterns: input.prevPatterns,
    });
    const after = evaluateSelectiveSync(rel, {
      mode: input.nextMode,
      patterns: input.nextPatterns,
    });
    if (before === after) {
      unchanged += 1;
      continue;
    }
    if (before && !after) wouldStop.push(rel);
    else wouldStart.push(rel);
  }
  wouldStop.sort();
  wouldStart.sort();
  return { wouldStop, wouldStart, unchangedCount: unchanged };
}

/** Severity classification for the impact diff so callers can pick the right
 * modal style without re-implementing thresholds. */
export type SelectiveSyncImpactSeverity = "noop" | "info" | "warn" | "danger";

export function scoreSelectiveSyncImpact(impact: SelectiveSyncImpact): SelectiveSyncImpactSeverity {
  if (impact.wouldStop.length === 0 && impact.wouldStart.length === 0) return "noop";
  if (impact.wouldStop.length === 0) return "info";
  if (impact.wouldStop.length >= 10) return "danger";
  return "warn";
}
