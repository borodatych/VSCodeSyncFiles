/**
 * v2.20.2 — typed shape + skeleton planner for the planned DuckDB-WASM
 * analytics surface inside the settings webview. **Skeleton.**
 *
 * The real implementation will:
 *   1. Lazy-load `@duckdb/duckdb-wasm` in the webview.
 *   2. Mount the JSONL `activity.json` and the row-store `stats.json` as
 *      virtual tables.
 *   3. Run the user-supplied SQL with a 5 s timeout and a 100 MB result
 *      cap.
 *
 * Until then this module:
 *   - Validates that the SQL is read-only (no DDL, no DML, no DROP …).
 *   - Returns a deterministic plan struct so the UI can render a "would
 *     execute" preview without DuckDB present.
 */

const FORBIDDEN_KEYWORDS_RE = /\b(insert|update|delete|drop|truncate|alter|attach|copy|create)\b/i;

export type AnalyticsValidationResult =
  | { ok: true }
  | { ok: false; reason: AnalyticsValidationRejection };

export type AnalyticsValidationRejection =
  | "empty_sql"
  | "non_select_keyword_present"
  | "unbalanced_quotes"
  | "comment_block_unclosed";

/** Strict read-only validator. Whitelist: any SQL that does not contain a
 * forbidden keyword and has balanced quotes / closed comment blocks. */
export function validateReadOnlySql(raw: string): AnalyticsValidationResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty_sql" };
  if (FORBIDDEN_KEYWORDS_RE.test(trimmed)) {
    return { ok: false, reason: "non_select_keyword_present" };
  }
  if (!quotesBalanced(trimmed)) return { ok: false, reason: "unbalanced_quotes" };
  if (hasUnclosedBlockComment(trimmed)) return { ok: false, reason: "comment_block_unclosed" };
  return { ok: true };
}

function quotesBalanced(sql: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (const ch of sql) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle) inDouble = !inDouble;
  }
  return !inSingle && !inDouble;
}

function hasUnclosedBlockComment(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const closeIdx = sql.indexOf("*/", i + 2);
      if (closeIdx === -1) return true;
      i = closeIdx + 2;
      continue;
    }
    i += 1;
  }
  return false;
}

export interface AnalyticsPlanInput {
  /** SQL as typed by the user. */
  sql: string;
  /** Caller-supplied timeout cap; default 5000 ms. */
  timeoutMs?: number;
  /** Max rows to return; default 10_000. */
  rowLimit?: number;
}

export interface AnalyticsPlanOk {
  ok: true;
  /** Echoed (trimmed) SQL the executor would run. */
  sql: string;
  timeoutMs: number;
  rowLimit: number;
  /** Tables the executor needs mounted before running. */
  requiredTables: AnalyticsTable[];
}

export interface AnalyticsPlanFail {
  ok: false;
  reason: AnalyticsValidationRejection;
}

export type AnalyticsPlan = AnalyticsPlanOk | AnalyticsPlanFail;

export type AnalyticsTable = "activity" | "stats" | "snapshots";

const TABLE_PATTERNS: Record<AnalyticsTable, RegExp> = {
  activity: /\bactivity\b/i,
  stats: /\bstats\b/i,
  snapshots: /\bsnapshots\b/i,
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ROW_LIMIT = 10_000;

export function planAnalyticsQuery(input: AnalyticsPlanInput): AnalyticsPlan {
  const validation = validateReadOnlySql(input.sql);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const trimmed = input.sql.trim();
  const requiredTables: AnalyticsTable[] = [];
  for (const [table, pattern] of Object.entries(TABLE_PATTERNS) as [AnalyticsTable, RegExp][]) {
    if (pattern.test(trimmed)) requiredTables.push(table);
  }
  return {
    ok: true,
    sql: trimmed,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    rowLimit: input.rowLimit ?? DEFAULT_ROW_LIMIT,
    requiredTables,
  };
}

export class AnalyticsBackendNotImplementedError extends Error {
  readonly code = "analytics_backend_not_implemented" as const;
  constructor(message = "DuckDB analytics backend is in skeleton mode (v2.20.2 in roadmap).") {
    super(message);
    this.name = "AnalyticsBackendNotImplementedError";
  }
}
