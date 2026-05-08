/**
 * v3.J — pure template renderer for `.vscodesync-strategy` and a "what does
 * this rule set actually do to my workspace" planner used by the
 * `vscodesync.editStrategy` UI command before saving.
 *
 * No `vscode` import. Caller writes the template via `workspace.fs.writeFile`
 * and surfaces the planner output through a webview / OutputChannel.
 */

import {
  resolveStrategy,
  type StrategyRule,
  type SyncStrategy,
} from "./perFolderSyncStrategy.js";

/** Render a starter `.vscodesync-strategy` template covering each strategy
 * with a representative example (commented out) so the user can flip them on
 * by uncommenting. */
export function renderStrategyFileTemplate(): string {
  return [
    "# .vscodesync-strategy — per-folder sync mode (first match wins).",
    "#",
    "# Format:   <pattern>   <strategy>",
    "# Patterns: gitignore-style globs (* / ** / ?). Trailing / = directory.",
    "# Strategies:",
    "#   never        — never sync (e.g. node_modules)",
    "#   local-only   — keep on this machine, never to cloud or P2P",
    "#   p2p-only     — only across direct WebRTC peers, never to cloud",
    "#   cloud        — full cloud sync (default fallback when no rule matches)",
    "#",
    "# Examples (uncomment as needed):",
    "# node_modules/  never",
    "# secrets/       p2p-only",
    "# .vscode/       local-only",
    "# *              cloud",
    "",
  ].join("\n");
}

export interface StrategyImpactBucket {
  strategy: SyncStrategy;
  count: number;
  /** Up to `sampleLimit` representative paths per bucket so the UI can show
   * "first N of M" without dumping the entire workspace. */
  sample: string[];
}

export interface StrategyImpactReport {
  /** Buckets in the canonical order: never, local-only, p2p-only, cloud. */
  buckets: StrategyImpactBucket[];
  /** Files that would have synced under default behaviour but no longer do. */
  noLongerSyncing: number;
  /** Total tracked files inspected. */
  totalFiles: number;
}

const STRATEGY_ORDER: readonly SyncStrategy[] = [
  "never",
  "local-only",
  "p2p-only",
  "cloud",
];

const DEFAULT_SAMPLE_LIMIT = 5;

export interface PlanStrategyImpactOptions {
  sampleLimit?: number;
}

/** Walk every tracked path through the rule set and aggregate results into
 * one bucket per strategy. Caller decides which buckets to show prominently
 * (typically `never` and `local-only` for warnings, since those flip files
 * out of cloud sync). */
export function planStrategyImpact(
  trackedRelPaths: string[],
  rules: StrategyRule[],
  options: PlanStrategyImpactOptions = {},
): StrategyImpactReport {
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const counts: Record<SyncStrategy, number> = {
    never: 0,
    "local-only": 0,
    "p2p-only": 0,
    cloud: 0,
  };
  const samples: Record<SyncStrategy, string[]> = {
    never: [],
    "local-only": [],
    "p2p-only": [],
    cloud: [],
  };
  for (const rel of trackedRelPaths) {
    const s = resolveStrategy(rel, rules);
    counts[s] += 1;
    if (samples[s].length < sampleLimit) samples[s].push(rel);
  }
  const buckets: StrategyImpactBucket[] = STRATEGY_ORDER.map((s) => ({
    strategy: s,
    count: counts[s],
    sample: samples[s],
  }));
  // "Stops syncing to cloud" = anything not in the cloud bucket.
  const noLongerSyncing = trackedRelPaths.length - counts.cloud;
  return {
    buckets,
    noLongerSyncing,
    totalFiles: trackedRelPaths.length,
  };
}

/** Severity classification consistent with selectiveSyncTemplate so callers
 * can route both impact reports through the same modal. */
export type StrategyImpactSeverity = "noop" | "info" | "warn" | "danger";

export function scoreStrategyImpact(report: StrategyImpactReport): StrategyImpactSeverity {
  if (report.totalFiles === 0) return "noop";
  if (report.noLongerSyncing === 0) return "noop";
  // Files marked `never` are the loudest signal — they fall off cloud AND P2P.
  const neverCount = report.buckets.find((b) => b.strategy === "never")?.count ?? 0;
  if (neverCount >= 10 || report.noLongerSyncing >= report.totalFiles / 2) {
    return "danger";
  }
  if (report.noLongerSyncing >= 3) return "warn";
  return "info";
}
