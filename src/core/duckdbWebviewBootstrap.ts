/**
 * v2.20.2 — DuckDB-WASM webview bootstrap planner (pure).
 *
 * The webview-side worker bundle (`duckdb-browser-mvp.worker.js`) plus the
 * matching WASM blob (`duckdb-mvp.wasm`) need to be wired into a panel
 * before `createDuckDbHost` (in `duckdbWorkerHost.ts`) can talk to a real
 * DuckDB instance.
 *
 * This module is the pure, vscode-free part of that bootstrap: it picks the
 * right worker / WASM variant from the bundle map and builds the HTML +
 * CSP for the webview. The thin imperative wrapper (in `ui/`) takes
 * `vscode.Uri`s produced by `Webview.asWebviewUri(...)` and feeds them in.
 */

/** A single DuckDB-WASM bundle variant exported by `getJsDelivrBundles`. */
export interface DuckDbBundleVariant {
  /** Worker JS — one of `duckdb-browser-mvp.worker.js`,
   *  `duckdb-browser-eh.worker.js`, `duckdb-browser-coi.worker.js`. */
  workerWebviewUri: string;
  /** Matching WASM file — `duckdb-mvp.wasm`, `duckdb-eh.wasm`,
   *  `duckdb-coi.wasm`. Variant choice mirrors the worker variant. */
  wasmWebviewUri: string;
  /** Stable identifier used by callers to pick variants. */
  variant: "mvp" | "eh" | "coi";
}

export interface DuckDbBootstrapInput {
  /** All variants resolved through `Webview.asWebviewUri(...)`. */
  bundles: DuckDbBundleVariant[];
  /** Webview's `cspSource` — used to build the CSP `script-src`. */
  cspSource: string;
  /** Single-use nonce for the inline bootstrap `<script>` block. */
  nonce: string;
  /** Bridge module URI (the webview-side glue that wraps `Worker(...)`
   *  and bridges its `postMessage` into the host contract). Caller
   *  supplies because it lives in the `media/` dir. */
  bridgeWebviewUri: string;
  /** Optional capability flags from the host environment.
   *  - `crossOriginIsolated` enables the `coi` (multi-thread) variant.
   *  - `exceptionHandling` enables the `eh` variant.
   *  Defaults pick the safest variant (`mvp`). */
  capabilities?: {
    crossOriginIsolated?: boolean;
    exceptionHandling?: boolean;
  };
}

export interface DuckDbBootstrapOutput {
  /** Full webview HTML, ready to assign to `panel.webview.html`. */
  html: string;
  /** The variant the bootstrap will load. Surfaced for telemetry / tests. */
  selectedVariant: DuckDbBundleVariant["variant"];
}

/** Pick the most capable variant the runtime supports, falling back to
 *  `mvp` (WebAssembly v1). Matches DuckDB-WASM's own `selectBundle` order. */
export function selectDuckDbVariant(
  bundles: DuckDbBundleVariant[],
  capabilities?: DuckDbBootstrapInput["capabilities"],
): DuckDbBundleVariant {
  const has = (v: DuckDbBundleVariant["variant"]): DuckDbBundleVariant | undefined =>
    bundles.find((b) => b.variant === v);
  if (capabilities?.crossOriginIsolated) {
    const coi = has("coi");
    if (coi) return coi;
  }
  if (capabilities?.exceptionHandling) {
    const eh = has("eh");
    if (eh) return eh;
  }
  const mvp = has("mvp");
  if (mvp) return mvp;
  if (bundles.length === 0) {
    throw new DuckDbBootstrapNoBundlesError();
  }
  return bundles[0];
}

/** Build the bootstrap HTML for a DuckDB-WASM analytics panel.
 *
 *  The HTML layout is fixed:
 *    1. nonce-locked CSP that allows only `cspSource` for `script-src` /
 *       `worker-src`, blocks all other origins, and bans inline-eval (the
 *       worker bundle does not need it).
 *    2. A single inline `<script type="module">` that imports the bridge
 *       module and instantiates the worker with the variant URIs.
 *    3. No body content — the bridge swaps in chrome once `init` resolves.
 *
 *  HTML escaping is sufficient because all values originate from
 *  `asWebviewUri(...)` (URIs) or `randomBytes` (nonce) — none contain
 *  user input.
 */
export function buildDuckDbBootstrapHtml(input: DuckDbBootstrapInput): DuckDbBootstrapOutput {
  const variant = selectDuckDbVariant(input.bundles, input.capabilities);
  const csp = [
    `default-src 'none'`,
    `style-src ${input.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${input.nonce}' ${input.cspSource}`,
    `worker-src ${input.cspSource} blob:`,
    `connect-src ${input.cspSource}`,
  ].join("; ");

  const html = [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `  <meta charset="UTF-8" />`,
    `  <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    `  <title>VSCodeSync · DuckDB Analytics</title>`,
    `</head>`,
    `<body>`,
    `  <main id="root"></main>`,
    `  <script type="module" nonce="${input.nonce}">`,
    `    import { bootstrapDuckDb } from ${JSON.stringify(input.bridgeWebviewUri)};`,
    `    bootstrapDuckDb({`,
    `      workerUrl: ${JSON.stringify(variant.workerWebviewUri)},`,
    `      wasmUrl: ${JSON.stringify(variant.wasmWebviewUri)},`,
    `      variant: ${JSON.stringify(variant.variant)},`,
    `    });`,
    `  </script>`,
    `</body>`,
    `</html>`,
  ].join("\n");

  return { html, selectedVariant: variant.variant };
}

export class DuckDbBootstrapNoBundlesError extends Error {
  readonly code = "duckdb_bootstrap_no_bundles" as const;
  constructor() {
    super(
      "DuckDB-WASM bootstrap: no bundle variants were supplied. Resolve at " +
        "least the MVP variant via Webview.asWebviewUri(...) before invoking " +
        "buildDuckDbBootstrapHtml().",
    );
    this.name = "DuckDbBootstrapNoBundlesError";
  }
}
