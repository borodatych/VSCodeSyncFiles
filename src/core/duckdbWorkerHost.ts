/**
 * v2.20.2 — DuckDB-WASM Worker host (skeleton).
 *
 * `@duckdb/duckdb-wasm@1.33` ships `getJsDelivrBundles` + `selectBundle` +
 * `AsyncDuckDB` which want a `Worker` URL and a webview-side bootstrap.
 * The pure planner `duckdbVirtualTables.ts:planVirtualTableMount` already
 * emits the SQL to mount `activity.json` + `stats.json` virtual tables.
 *
 * This module is the *host shape*: it defines the contract the webview
 * worker must implement so the analytics view can talk to it via
 * `postMessage`. The webview-side bundle is a separate ship — once it lands,
 * `instantiateWorkerHost` switches from skeleton to real.
 *
 * Wire shape (host ↔ worker):
 *
 *   in  : { kind: "init"; bundleUrl: string }
 *   in  : { kind: "register_file"; path: string; bytes: Uint8Array }
 *   in  : { kind: "exec_sql"; sql: string }   // returns rows[]
 *   out : { kind: "ready" }
 *   out : { kind: "rows"; rows: unknown[] }
 *   out : { kind: "error"; message: string }
 */

export type DuckDbHostInbound =
  | { kind: "init"; bundleUrl: string }
  | { kind: "register_file"; path: string; bytes: Uint8Array }
  | { kind: "exec_sql"; sql: string };

export type DuckDbHostOutbound =
  | { kind: "ready" }
  | { kind: "rows"; rows: unknown[] }
  | { kind: "error"; message: string };

/** A minimal Worker-like interface so the host code can be unit-tested
 *  without a real Worker thread. */
export interface DuckDbWorkerLike {
  postMessage: (msg: DuckDbHostInbound) => void;
  addEventListener: (
    event: "message",
    listener: (ev: { data: DuckDbHostOutbound }) => void,
  ) => void;
  removeEventListener: (
    event: "message",
    listener: (ev: { data: DuckDbHostOutbound }) => void,
  ) => void;
  terminate: () => void;
}

export interface DuckDbHost {
  /** Resolves once the worker reports ready. Reject on init error. */
  readonly init: (bundleUrl: string) => Promise<void>;
  /** Push a virtual file the worker should mount via `db.registerFileBuffer`. */
  readonly registerFile: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Run a SQL statement; returns rows (worker is the source of truth on the
   *  exact shape — host is row-shape agnostic). */
  readonly execSql: (sql: string) => Promise<unknown[]>;
  /** Tear down the worker. */
  readonly close: () => void;
}

export function createDuckDbHost(worker: DuckDbWorkerLike): DuckDbHost {
  let pendingResolve: ((rows: unknown[]) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;

  const handler = (ev: { data: DuckDbHostOutbound }): void => {
    const out = ev.data;
    if (out.kind === "ready") {
      readyResolve?.();
      readyResolve = null;
      readyReject = null;
      return;
    }
    if (out.kind === "rows") {
      pendingResolve?.(out.rows);
      pendingResolve = null;
      pendingReject = null;
      return;
    }
    const err = new Error(out.message);
    if (readyReject !== null) {
      readyReject(err);
      readyResolve = null;
      readyReject = null;
      return;
    }
    pendingReject?.(err);
    pendingResolve = null;
    pendingReject = null;
  };
  worker.addEventListener("message", handler);

  return {
    init(bundleUrl): Promise<void> {
      return new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
        worker.postMessage({ kind: "init", bundleUrl });
      });
    },
    registerFile(path, bytes): Promise<void> {
      worker.postMessage({ kind: "register_file", path, bytes });
      return Promise.resolve();
    },
    execSql(sql): Promise<unknown[]> {
      return new Promise((resolve, reject) => {
        if (pendingResolve !== null) {
          reject(new Error("duckdb host: previous query still in flight"));
          return;
        }
        pendingResolve = resolve;
        pendingReject = reject;
        worker.postMessage({ kind: "exec_sql", sql });
      });
    },
    close(): void {
      worker.removeEventListener("message", handler);
      worker.terminate();
    },
  };
}

export class DuckDbWorkerNotShippedError extends Error {
  readonly code = "duckdb_worker_not_shipped" as const;
  constructor(message?: string) {
    super(
      message ??
        "DuckDB-WASM webview worker bundle is not shipped yet (v2.20.2 in roadmap). " +
          "Host contract is wired; the worker bootstrap (`@duckdb/duckdb-wasm/dist/duckdb-browser.worker.js`) " +
          "is loaded by the analytics webview when that surface lands.",
    );
    this.name = "DuckDbWorkerNotShippedError";
  }
}
