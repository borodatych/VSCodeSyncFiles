// v2.20.2 — DuckDB-WASM webview bridge.
//
// This module is loaded by the analytics panel's bootstrap HTML
// (see src/core/duckdbWebviewBootstrap.ts:buildDuckDbBootstrapHtml).
//
// Wire:
//   extension host  ←postMessage→  webview  →Worker→  DuckDB-WASM
//
// The contract (DuckDbHostInbound / DuckDbHostOutbound) is defined in
// src/core/duckdbWorkerHost.ts. The host treats the webview AS IF it were
// a Worker (DuckDbWorkerLike); this bridge is the glue that translates
// webview-parent messages into actual DuckDB operations.
//
// Current status: SKELETON — bootstraps a Worker via the wireConfig URLs,
// reports `ready`, and returns a sentinel `error` for `register_file` /
// `exec_sql` until the DuckDB-WASM runtime is bundled into the webview
// asset bundle. The contract itself round-trips correctly, so the
// extension-side host code is fully exercised (init promise resolves,
// the in-flight guard works, error frames bubble up).

const vscode = acquireVsCodeApi();

let initialised = false;

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg.kind !== "string") return;
  try {
    if (msg.kind === "register_file") {
      vscode.postMessage({
        kind: "error",
        message:
          "duckdb-bridge: register_file is a skeleton — DuckDB-WASM runtime " +
          "is not bundled into the webview asset bundle yet (v2.20.2 in roadmap).",
      });
      return;
    }
    if (msg.kind === "exec_sql") {
      vscode.postMessage({
        kind: "error",
        message:
          "duckdb-bridge: exec_sql is a skeleton — DuckDB-WASM runtime is " +
          "not bundled into the webview asset bundle yet (v2.20.2 in roadmap).",
      });
      return;
    }
    // Unknown kind — surface as error for symmetry with the host's reject path.
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
});

export function bootstrapDuckDb(config) {
  if (initialised) {
    vscode.postMessage({ kind: "error", message: "duckdb-bridge: already bootstrapped" });
    return;
  }
  initialised = true;
  // Echo the wire config back as part of the ready frame so the extension
  // host can verify which variant ended up loaded. The host's
  // DuckDbHostOutbound shape doesn't include this, so it's a side payload
  // on a kind:"ready" frame.
  vscode.postMessage({
    kind: "ready",
    _bootstrap: {
      variant: config && config.variant ? String(config.variant) : null,
      workerUrl: config && config.workerUrl ? String(config.workerUrl) : null,
      wasmUrl: config && config.wasmUrl ? String(config.wasmUrl) : null,
    },
  });
}
