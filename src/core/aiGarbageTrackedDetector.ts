/**
 * Pure heuristic + LM prompt builder for the "garbage tracked file" detector.
 * Walks a manifest + recent activity sample, scores files by suspicion (build
 * artifacts, cache directories, log files), then returns a short list to
 * surface to the user as "should be in `.vscodesync.ignore`?".
 *
 * Heuristics-only path is the cheap default; the LM call narrows borderline
 * cases. vscode-free.
 */

export interface FileSample {
  /** POSIX relative path from workspace root. */
  path: string;
  /** Times this path appeared as `push` in the activity log over the sample window. */
  pushCount: number;
  /** Latest known size in bytes. Optional; treats undefined as "unknown". */
  sizeBytes?: number;
}

export interface GarbageCandidate {
  path: string;
  /** 0..1 score; higher = more likely junk. */
  score: number;
  /** Human-readable list of triggered rules. */
  reasons: string[];
}

const RULES: readonly { test: RegExp; reason: string; weight: number }[] = [
  { test: /(?:^|\/)node_modules\//i, reason: "node_modules", weight: 1.0 },
  { test: /(?:^|\/)\.next\//i, reason: "Next.js build cache", weight: 0.9 },
  { test: /(?:^|\/)\.cache\//i, reason: "cache directory", weight: 0.8 },
  { test: /(?:^|\/)dist\//i, reason: "dist (build output)", weight: 0.7 },
  { test: /(?:^|\/)build\//i, reason: "build (output)", weight: 0.6 },
  { test: /(?:^|\/)coverage\//i, reason: "coverage reports", weight: 0.7 },
  { test: /(?:^|\/)out\//i, reason: "out (output)", weight: 0.5 },
  { test: /\.log$/i, reason: "log file", weight: 0.6 },
  { test: /\.tmp$/i, reason: "temp file", weight: 0.7 },
  { test: /\.pyc$/i, reason: "Python bytecode", weight: 0.9 },
  { test: /(?:^|\/)__pycache__\//i, reason: "Python cache dir", weight: 0.9 },
  { test: /\.DS_Store$/i, reason: "macOS metadata", weight: 1.0 },
  { test: /(?:^|\/)Thumbs\.db$/i, reason: "Windows thumb cache", weight: 1.0 },
];

const HIGH_CHURN_THRESHOLD = 20;
const LARGE_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MIN_SCORE = 0.6;

export function scoreSample(sample: FileSample): GarbageCandidate {
  const reasons: string[] = [];
  let score = 0;
  for (const r of RULES) {
    if (r.test.test(sample.path)) {
      reasons.push(r.reason);
      score = Math.max(score, r.weight);
    }
  }
  if (sample.pushCount >= HIGH_CHURN_THRESHOLD) {
    reasons.push(`high churn (${String(sample.pushCount)} pushes)`);
    score = Math.min(1, score + 0.2);
  }
  if (sample.sizeBytes !== undefined && sample.sizeBytes >= LARGE_FILE_BYTES) {
    reasons.push(`large (${String(Math.round(sample.sizeBytes / (1024 * 1024)))} MB)`);
    score = Math.min(1, score + 0.1);
  }
  return { path: sample.path, score, reasons };
}

export function rankGarbageCandidates(
  samples: readonly FileSample[],
  minScore: number = DEFAULT_MIN_SCORE,
  topN = 30,
): GarbageCandidate[] {
  const scored = samples
    .map((s) => scoreSample(s))
    .filter((c) => c.score >= minScore && c.reasons.length > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, topN));
}

/** Build LM prompt that asks the model to confirm/deny each candidate. */
export function buildGarbagePrompt(candidates: readonly GarbageCandidate[]): string {
  const items = candidates
    .map((c) => `- ${c.path} [score=${c.score.toFixed(2)}; ${c.reasons.join(", ")}]`)
    .join("\n");
  return `You are auditing a developer's cloud-synced workspace. Below is a list
of files our heuristics flagged as probably junk that should NOT be tracked.

For each, output ONE line: "<path> | KEEP|IGNORE | <one-sentence reason>".
Use IGNORE for build artifacts, caches, logs, and OS metadata. Use KEEP only
if the file looks like real source / config / documentation.

Files:
${items}`;
}

/** Convert candidates into `.vscodesync.ignore` patterns (deduplicated). */
export function suggestIgnorePatterns(candidates: readonly GarbageCandidate[]): string[] {
  const out = new Set<string>();
  for (const c of candidates) {
    if (c.reasons.includes("node_modules")) out.add("node_modules/");
    else if (c.reasons.includes("Next.js build cache")) out.add(".next/");
    else if (c.reasons.includes("cache directory")) out.add(".cache/");
    else if (c.reasons.includes("dist (build output)")) out.add("dist/");
    else if (c.reasons.includes("build (output)")) out.add("build/");
    else if (c.reasons.includes("coverage reports")) out.add("coverage/");
    else if (c.reasons.includes("out (output)")) out.add("out/");
    else if (c.reasons.includes("Python cache dir")) out.add("__pycache__/");
    else if (c.path.endsWith(".log")) out.add("*.log");
    else if (c.path.endsWith(".tmp")) out.add("*.tmp");
    else if (c.path.endsWith(".pyc")) out.add("*.pyc");
    else if (c.path.endsWith(".DS_Store")) out.add(".DS_Store");
    else if (c.path.endsWith("Thumbs.db")) out.add("Thumbs.db");
    else out.add(c.path);
  }
  return [...out].sort();
}
