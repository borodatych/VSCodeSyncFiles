/**
 * Stats Dashboard sankey — "push from machine X → pull to machine Y" flow
 * visualisation. Pure layout in `src/core/sankeyLayout.ts`; this file is just
 * the webview shell + flow aggregation from the activity log.
 */
import * as vscode from "vscode";
import { loadActivityFile } from "../core/activityLog.js";
import { buildSankeyLayout, type SankeyLayout } from "../core/sankeyLayout.js";
import { getWebviewNonce } from "../utils/webviewNonce.js";
import { buildPushPullFlows } from "./sankeyPushPullFlows.js";

const WEBVIEW_VIEW_TYPE = "vscodesyncSankey";
const W = 720;
const H = 480;

let panel: vscode.WebviewPanel | undefined;
let lastStorageDir: string | undefined;

function buildHtml(n: string, csp: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${n}'" />
  <title>VSCodeSync · Sankey</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; margin: 0; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 6px 0; }
    p.muted { opacity: 0.75; font-size: 0.9em; margin: 4px 0 12px 0; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
    svg { display: block; margin-top: 8px; max-width: 100%; height: auto; background: transparent; }
    .label { font-size: 11px; fill: var(--vscode-foreground); pointer-events: none; }
    .empty { opacity: 0.6; padding: 16px; }
  </style>
</head>
<body>
  <h1>VSCodeSync · Sankey (push → pull)</h1>
  <p class="muted">Окно 30 дней. Слева — машины-источники push, справа — машины, делавшие pull. Толщина потока = число pull-событий.</p>
  <button id="btnRefresh" type="button">Обновить</button>
  <div id="chart"></div>
  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    const W = ${String(W)};
    const H = ${String(H)};
    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function render(layout) {
      if (!layout || !layout.nodes || layout.nodes.length === 0) {
        document.getElementById('chart').innerHTML = '<p class="empty">Нет данных push→pull за 30 дней.</p>';
        return;
      }
      const links = (layout.links || []).map(function(l) {
        return '<path d="' + l.path + '" stroke="var(--vscode-charts-blue,#4ec9b0)" stroke-opacity="0.45" stroke-width="' + l.thickness.toFixed(2) + '" fill="none" />';
      }).join('');
      const nodes = (layout.nodes || []).map(function(n) {
        const fill = n.side === 'source' ? 'var(--vscode-charts-blue,#4ec9b0)' : 'var(--vscode-charts-orange,#ce9178)';
        const tx = n.side === 'source' ? (n.x + n.width + 4) : (n.x - 4);
        const anchor = n.side === 'source' ? 'start' : 'end';
        const ty = n.y + n.height / 2 + 4;
        return '<g><rect x="' + n.x + '" y="' + n.y.toFixed(1) + '" width="' + n.width + '" height="' + n.height.toFixed(1) + '" fill="' + fill + '" />' +
               '<text class="label" x="' + tx + '" y="' + ty.toFixed(1) + '" text-anchor="' + anchor + '">' + esc(n.label) + ' (' + String(n.total) + ')</text></g>';
      }).join('');
      const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' + links + nodes + '</svg>';
      document.getElementById('chart').innerHTML = svg;
    }
    window.addEventListener('message', function(ev) {
      if (ev.data && ev.data.type === 'sankey' && ev.data.layout) render(ev.data.layout);
    });
    document.getElementById('btnRefresh').addEventListener('click', function() {
      vscode.postMessage({ type: 'refresh' });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

async function pushChart(wv: vscode.Webview, storageDir: string): Promise<void> {
  const file = await loadActivityFile(storageDir);
  const flows = buildPushPullFlows(file.events, Date.now());
  const layout: SankeyLayout = buildSankeyLayout(flows, {
    width: W - 220,
    height: H - 40,
    paddingTop: 20,
    paddingBottom: 20,
  });
  await wv.postMessage({ type: "sankey", layout });
}

export function openSankeyChartPanel(context: vscode.ExtensionContext, storageDir: string): void {
  lastStorageDir = storageDir;
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      WEBVIEW_VIEW_TYPE,
      "VSCodeSync · Sankey",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(
      () => {
        panel = undefined;
      },
      null,
      context.subscriptions,
    );
    panel.webview.onDidReceiveMessage(
      async (msg: { type?: string }) => {
        const dir = lastStorageDir;
        if (!dir || !panel) return;
        if (msg.type === "ready" || msg.type === "refresh") {
          await pushChart(panel.webview, dir);
        }
      },
      undefined,
      context.subscriptions,
    );
  }
  panel.reveal(vscode.ViewColumn.One, false);
  const wv = panel.webview;
  wv.html = buildHtml(getWebviewNonce(), wv.cspSource);
  void pushChart(wv, storageDir);
}
