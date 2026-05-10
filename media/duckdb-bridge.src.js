// v2.20.2 — DuckDB-WASM webview bridge (source).
//
// Bundled by `esbuild.mjs` into `dist/media/duckdb-bridge.js` with
// `@duckdb/duckdb-wasm` + `apache-arrow` inlined. The output is loaded by
// the analytics panel (see `src/commands/registerAnalyticsPanel.ts`)
// which sets `<script type="module">` against the bundled URI.
//
// Wire (host ↔ webview ↔ Worker ↔ DuckDB-WASM):
//   extension host  ←postMessage→  webview (this file)  →Worker→  duckdb-wasm
//
// Contract: see `src/core/duckdbWorkerHost.ts` for the full
// `DuckDbHostInbound` / `DuckDbHostOutbound` shape. The host treats the
// webview as if it were a `Worker` via `createWebviewWorkerAdapter` —
// this file fulfils that contract.

import { AsyncDuckDB, ConsoleLogger } from "@duckdb/duckdb-wasm";

const vscode = acquireVsCodeApi();

let db = null;
let conn = null;
let initialised = false;

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg.kind !== "string") return;
  void handleInbound(msg);
});

async function handleInbound(msg) {
  try {
    if (msg.kind === "register_file") {
      await handleRegisterFile(msg);
      return;
    }
    if (msg.kind === "exec_sql") {
      await handleExecSql(msg);
      return;
    }
    vscode.postMessage({
      kind: "error",
      message: "duckdb-bridge: unknown message kind " + JSON.stringify(msg.kind),
    });
  } catch (e) {
    vscode.postMessage({
      kind: "error",
      message: "duckdb-bridge: handler crashed — " + (e && e.message ? e.message : String(e)),
    });
  }
}

async function handleRegisterFile(msg) {
  if (!db) {
    vscode.postMessage({
      kind: "error",
      message: "duckdb-bridge: register_file before init",
    });
    return;
  }
  await db.registerFileBuffer(msg.path, msg.bytes);
  // No outbound for register_file — host's promise resolves on send (no ack).
}

async function handleExecSql(msg) {
  if (!conn) {
    vscode.postMessage({
      kind: "error",
      message: "duckdb-bridge: exec_sql before init",
    });
    return;
  }
  const table = await conn.query(msg.sql);
  // Convert Arrow Table to plain JSON-serialisable rows. `toArray()` returns
  // proxy rows whose properties match column names; we copy them through a
  // plain object and stringify BigInt cells (the structured-clone algorithm
  // used by webview postMessage rejects BigInts).
  const rows = [];
  for (const row of table.toArray()) {
    const obj = {};
    for (const key of Object.keys(row)) {
      const v = row[key];
      obj[key] = typeof v === "bigint" ? v.toString() : v;
    }
    rows.push(obj);
  }
  vscode.postMessage({ kind: "rows", rows });
}

export async function bootstrapDuckDb(config) {
  if (initialised) {
    vscode.postMessage({ kind: "error", message: "duckdb-bridge: already bootstrapped" });
    return;
  }
  initialised = true;
  try {
    if (!config || !config.workerUrl || !config.wasmUrl) {
      throw new Error("bootstrap config missing workerUrl / wasmUrl");
    }
    // The DuckDB worker bundle uses `importScripts(...)` internally, so we
    // wrap it in a Blob with the correct MIME type to honour the webview's
    // CSP `worker-src ${cspSource} blob:` directive.
    const workerLoader = `importScripts(${JSON.stringify(config.workerUrl)});`;
    const blob = new Blob([workerLoader], { type: "text/javascript" });
    const bootstrapWorkerUrl = URL.createObjectURL(blob);
    const worker = new Worker(bootstrapWorkerUrl);
    const logger = new ConsoleLogger();
    db = new AsyncDuckDB(logger, worker);
    await db.instantiate(config.wasmUrl);
    URL.revokeObjectURL(bootstrapWorkerUrl);
    conn = await db.connect();
    vscode.postMessage({
      kind: "ready",
      _bootstrap: {
        variant: String(config.variant ?? "mvp"),
        workerUrl: String(config.workerUrl),
        wasmUrl: String(config.wasmUrl),
      },
    });
  } catch (e) {
    vscode.postMessage({
      kind: "error",
      message: "duckdb-bridge: bootstrap failed — " + (e && e.message ? e.message : String(e)),
    });
  }
}
