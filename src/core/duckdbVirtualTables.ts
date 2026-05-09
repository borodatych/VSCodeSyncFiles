/**
 * v2.20.2 — DuckDB-WASM virtual-table mount planner (skeleton).
 *
 * The DuckDB-WASM bundle (`@duckdb/duckdb-wasm` already in dependencies)
 * runs from a Web Worker; mounting `activity.json` and `stats.json` as
 * virtual tables lets the analytics webview run aggregate queries with
 * sub-second latency over years of activity history.
 *
 * Concrete mount steps (issued through DuckDB SQL):
 *   1. `INSTALL json; LOAD json;`
 *   2. `CREATE VIEW activity AS
 *         SELECT * FROM read_json_auto('activity.json', maximum_object_size=...)`
 *   3. Same for stats.
 *
 * This module is the *planner*: it produces the SQL statements + the
 * required virtual-file registrations from a snapshot of file paths +
 * sizes. Wiring (Worker init, `db.registerFileBuffer`, query) lives in
 * `src/ui/duckdbAnalyticsHost.ts` once the webview exposes a Worker host.
 *
 * No `vscode` import — pure planner.
 */

export interface VirtualTableSource {
  /** SQL identifier — must match the JSON shape's natural name. */
  readonly tableName: string;
  /** Virtual filesystem path — matches the name passed to `registerFileBuffer`. */
  readonly virtualFilePath: string;
  /** Approx byte size — used to set `maximum_object_size` per source. */
  readonly sizeBytes: number;
  /** Json shape — `array_of_objects` (default) or `single_object`. */
  readonly shape?: "array_of_objects" | "single_object";
}

export interface VirtualTableMountPlan {
  readonly setupStatements: readonly string[];
  readonly mountStatements: readonly string[];
  /** Files the host must `db.registerFileBuffer(path, contents)` before
   *  running the mount statements. */
  readonly virtualFiles: readonly string[];
}

/** DuckDB-WASM defaults to a 16 MB maximum_object_size; we bump per-file. */
const MIN_MAX_OBJECT_BYTES = 16 * 1024 * 1024;

export function planVirtualTableMount(
  sources: readonly VirtualTableSource[],
): VirtualTableMountPlan {
  if (sources.length === 0) {
    return { setupStatements: [], mountStatements: [], virtualFiles: [] };
  }
  const setupStatements = ["INSTALL json;", "LOAD json;"];
  const mountStatements: string[] = [];
  const virtualFiles: string[] = [];
  for (const s of sources) {
    if (!isSqlIdent(s.tableName)) {
      throw new Error(`planVirtualTableMount: invalid SQL identifier ${s.tableName}`);
    }
    const cap = Math.max(MIN_MAX_OBJECT_BYTES, s.sizeBytes * 2);
    const shapeArg =
      s.shape === "single_object"
        ? `, maximum_object_size=${String(cap)}`
        : `, maximum_object_size=${String(cap)}`;
    mountStatements.push(
      `CREATE OR REPLACE VIEW ${s.tableName} AS SELECT * FROM read_json_auto('${s.virtualFilePath}'${shapeArg});`,
    );
    virtualFiles.push(s.virtualFilePath);
  }
  return { setupStatements, mountStatements, virtualFiles };
}

function isSqlIdent(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

export class DuckDbHostNotAvailableError extends Error {
  readonly code = "duckdb_host_not_available" as const;
  constructor(message?: string) {
    super(
      message ??
        "DuckDB-WASM Worker host is not wired yet (v2.20.2 in roadmap). " +
          "The mount planner is ready; the Worker host lands when the analytics webview surfaces.",
    );
    this.name = "DuckDbHostNotAvailableError";
  }
}
