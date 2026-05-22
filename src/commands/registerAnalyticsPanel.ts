/**
 * v2.20.2 — Analytics panel command (`vscodesync.openAnalyticsPanel`).
 *
 * Opens a webview that bootstraps the DuckDB-WASM bridge bundled at
 * `dist/media/duckdb-bridge.js` (built from `media/duckdb-bridge.src.js`
 * by `esbuild.mjs`). The bridge inlines `@duckdb/duckdb-wasm` +
 * `apache-arrow`, instantiates `AsyncDuckDB(logger, worker)`, and
 * fulfils the `DuckDbHostInbound` / `DuckDbHostOutbound` contract from
 * `src/core/duckdbWorkerHost.ts`.
 *
 * Wire: extension host ↔ webview (bridge) ↔ Worker ↔ DuckDB-WASM. The
 * `createWebviewWorkerAdapter` below makes the webview look like a
 * `Worker` to the existing `createDuckDbHost(...)` code, so any future
 * caller (analytics surface) gets a typed `DuckDbHost` for free.
 */
import * as vscode from "vscode";
import { buildDuckDbBootstrapHtml, type DuckDbBundleVariant } from "../core/duckdbWebviewBootstrap.js";
import {
  createDuckDbHost,
  type DuckDbHost,
  type DuckDbHostInbound,
  type DuckDbHostOutbound,
  type DuckDbWorkerLike,
} from "../core/duckdbWorkerHost.js";
import { getWebviewNonce } from "../utils/webviewNonce.js";

const COMMAND_ID = "vscodesync.openAnalyticsPanel";
const WEBVIEW_VIEW_TYPE = "vscodesyncAnalytics";

let activePanel: vscode.WebviewPanel | undefined;
let activeHost: DuckDbHost | undefined;

export interface RegisterAnalyticsPanelDeps {
  context: vscode.ExtensionContext;
}

export function registerAnalyticsPanel(deps: RegisterAnalyticsPanelDeps): vscode.Disposable[] {
  const { context } = deps;
  const cmd = vscode.commands.registerCommand(COMMAND_ID, async () => {
    if (activePanel) {
      activePanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      WEBVIEW_VIEW_TYPE,
      "VSCodeSync · Analytics",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
          vscode.Uri.joinPath(context.extensionUri, "dist", "media"),
          vscode.Uri.joinPath(context.extensionUri, "node_modules", "@duckdb", "duckdb-wasm", "dist"),
        ],
      },
    );
    activePanel = panel;
    panel.onDidDispose(() => {
      activePanel = undefined;
      activeHost?.close();
      activeHost = undefined;
    });

    const adapter = createWebviewWorkerAdapter(panel.webview, () => { panel.dispose(); });
    const host = createDuckDbHost(adapter);
    activeHost = host;

    const bridgeWebviewUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "dist", "media", "duckdb-bridge.js"),
    ).toString();
    const bundles = resolveBundles(panel.webview, context.extensionUri);
    const nonce = getWebviewNonce();
    const { html } = buildDuckDbBootstrapHtml({
      bundles,
      cspSource: panel.webview.cspSource,
      nonce,
      bridgeWebviewUri,
    });
    panel.webview.html = html;

    try {
      await host.init(bridgeWebviewUri);
      void vscode.window.showInformationMessage(
        "VSCodeSync · Analytics: DuckDB-WASM ready. Use `host.execSql(...)` " +
          "via the analytics surface (work in progress) to query activity / stats.",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await vscode.window.showErrorMessage(`VSCodeSync · Analytics bootstrap failed: ${msg}`);
    }
  });
  return [cmd];
}

/** Resolve the three DuckDB-WASM variants from the local node_modules bundle.
 *  When the runtime is upgraded to ship variants from a vendored asset
 *  directory, swap the path roots — the rest of the wiring is variant-agnostic. */
function resolveBundles(webview: vscode.Webview, extensionUri: vscode.Uri): DuckDbBundleVariant[] {
  const dist = vscode.Uri.joinPath(extensionUri, "node_modules", "@duckdb", "duckdb-wasm", "dist");
  const variant = (kind: DuckDbBundleVariant["variant"], workerName: string, wasmName: string): DuckDbBundleVariant => ({
    variant: kind,
    workerWebviewUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, workerName)).toString(),
    wasmWebviewUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, wasmName)).toString(),
  });
  return [
    variant("mvp", "duckdb-browser-mvp.worker.js", "duckdb-mvp.wasm"),
    variant("eh", "duckdb-browser-eh.worker.js", "duckdb-eh.wasm"),
    variant("coi", "duckdb-browser-coi.worker.js", "duckdb-coi.wasm"),
  ];
}

/** Adapt a `vscode.Webview` to the `DuckDbWorkerLike` shape so the
 *  existing `createDuckDbHost(...)` works against the webview as if it
 *  were a Worker. Translates the EventTarget contract to the disposable-
 *  based `onDidReceiveMessage`. */
export function createWebviewWorkerAdapter(
  webview: vscode.Webview,
  terminate: () => void,
): DuckDbWorkerLike {
  const subscriptions = new Map<
    (ev: { data: DuckDbHostOutbound }) => void,
    vscode.Disposable
  >();
  return {
    postMessage(msg: DuckDbHostInbound): void {
      void webview.postMessage(msg);
    },
    addEventListener(_event, listener): void {
      const d = webview.onDidReceiveMessage((data: unknown) => {
        listener({ data: data as DuckDbHostOutbound });
      });
      subscriptions.set(listener, d);
    },
    removeEventListener(_event, listener): void {
      subscriptions.get(listener)?.dispose();
      subscriptions.delete(listener);
    },
    terminate(): void {
      for (const d of subscriptions.values()) d.dispose();
      subscriptions.clear();
      terminate();
    },
  };
}

