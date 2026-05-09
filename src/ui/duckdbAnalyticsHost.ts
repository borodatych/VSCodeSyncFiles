/**
 * v2.20.2 — DuckDB-WASM analytics host (skeleton with real lazy-load).
 *
 * Currently exposes:
 *   - `loadDuckDb()` — lazy import of `@duckdb/duckdb-wasm`. Returns null
 *     when the bundle is not available in this build.
 *   - `runReadOnlyQuery(sql)` — validates SQL via the existing
 *     `validateReadOnlySql`, returns a sentinel error stating that the
 *     virtual-table mount layer (activity.json + stats.json) is the
 *     follow-up.
 *
 * Why a stub: DuckDB-WASM works best from a Worker in a webview; from the
 * extension host the WASM path is awkward. The full implementation will
 * register the analytics SQL surface inside the settings webview and pass
 * results back over postMessage. This module pins the dependency so future
 * work doesn't need a fresh `npm install` round.
 */
import { validateReadOnlySql, type AnalyticsValidationResult } from "../core/analyticsQueryShape.js";
import { warnLog } from "../utils/log.js";

interface DuckDbModuleLike {
  // Surface left intentionally `unknown` — the real types live behind the
  // WASM boundary; the host mounting layer (webview) consumes them. Keeping
  // the shape opaque here prevents a cascade of placeholder types in the
  // public surface.
  AsyncDuckDB?: unknown;
  selectBundle?: unknown;
}

let cached: DuckDbModuleLike | null | undefined;

export async function loadDuckDb(): Promise<DuckDbModuleLike | null> {
  if (cached !== undefined) return cached;
  try {
    const dynamic = (specifier: string): Promise<unknown> => import(specifier);
    cached = (await dynamic("@duckdb/duckdb-wasm")) as DuckDbModuleLike;
  } catch (e) {
    warnLog("duckdb", `bundle not loadable: ${e instanceof Error ? e.message : String(e)}`);
    cached = null;
  }
  return cached;
}

export type AnalyticsRunResult =
  | { ok: true; rows: unknown[]; columns: string[] }
  | { ok: false; reason: "validation"; detail: AnalyticsValidationResult }
  | { ok: false; reason: "duckdb_unavailable" }
  | { ok: false; reason: "tables_not_mounted" };

/** Skeleton runner. The real path will create an `AsyncDuckDB` instance,
 * mount activity.json + stats.json as virtual tables, run the SQL with a
 * 5 s timeout, and stream rows back. Tests cover validation only. */
export async function runReadOnlyQuery(sql: string): Promise<AnalyticsRunResult> {
  const validation = validateReadOnlySql(sql);
  if (!validation.ok) {
    return { ok: false, reason: "validation", detail: validation };
  }
  const duck = await loadDuckDb();
  if (!duck) return { ok: false, reason: "duckdb_unavailable" };
  return { ok: false, reason: "tables_not_mounted" };
}
