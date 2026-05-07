/**
 * Multi-machine graph webview — visualises which machine touched which
 * workspace over the last 30 days, using the activity log as the source.
 *
 * Layout is computed by the pure helper in `machineGraphLayout.ts`; the
 * webview just renders SVG circles + lines from the resulting matrix.
 */
import * as vscode from "vscode";
import { loadActivityFile } from "../core/activityLog.js";
import { getWebviewNonce } from "../utils/webviewNonce.js";
import { buildMachineGraph, type MachineGraph } from "./machineGraphLayout.js";

const WEBVIEW_VIEW_TYPE = "vscodesyncMachineGraph";
const W = 720;
const H = 520;

let panel: vscode.WebviewPanel | undefined;
let lastStorageDir: string | undefined;

function buildHtml(n: string, csp: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${n}'" />
  <title>VSCodeSync · Machines</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; margin: 0; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 6px 0; }
    p.muted { opacity: 0.75; font-size: 0.9em; margin: 4px 0 12px 0; }
    .legend { font-size: 0.85em; opacity: 0.8; }
    .legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin: 0 4px 0 8px; vertical-align: middle; }
    .machine-fill { background: var(--vscode-charts-blue, #4ec9b0); }
    .workspace-fill { background: var(--vscode-charts-orange, #ce9178); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
    svg { display: block; margin-top: 8px; max-width: 100%; height: auto; background: transparent; }
    .label { font-size: 11px; fill: var(--vscode-foreground); pointer-events: none; }
  </style>
</head>
<body>
  <h1>VSCodeSync · граф машин и воркспейсов</h1>
  <p class="muted">Окно 30 дней. Внешний круг — машины, внутренний — воркспейсы. Толщина линии = число событий sync.</p>
  <div class="legend">
    Легенда:
    <span class="dot machine-fill"></span> машина
    <span class="dot workspace-fill"></span> workspace
    <button id="btnRefresh" type="button" style="margin-left:12px">Обновить</button>
  </div>
  <div id="graph"></div>
  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    const W = ${String(W)};
    const H = ${String(H)};
    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function render(g) {
      const peak = Math.max(1, g.maxEdgeWeight);
      const lines = (g.edges || []).map(function(e) {
        const a = g.nodes.find(n => n.id === e.from && n.kind === 'machine');
        const b = g.nodes.find(n => n.id === e.to && n.kind === 'workspace');
        if (!a || !b) return '';
        const sw = (1 + 4 * (e.weight / peak)).toFixed(2);
        const op = (0.25 + 0.55 * (e.weight / peak)).toFixed(2);
        return '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) +
               '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
               '" stroke="var(--vscode-foreground)" stroke-opacity="' + op +
               '" stroke-width="' + sw + '" />';
      }).join('');
      const machines = g.nodes.filter(n => n.kind === 'machine').map(function(n) {
        const r = 8 + Math.min(12, n.weight * 0.4);
        return '<g><circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) +
               '" r="' + r.toFixed(1) + '" fill="var(--vscode-charts-blue,#4ec9b0)" />' +
               '<text class="label" x="' + (n.x + r + 4).toFixed(1) + '" y="' + (n.y + 4).toFixed(1) +
               '">' + esc(n.name) + ' (' + String(n.weight) + ')</text></g>';
      }).join('');
      const workspaces = g.nodes.filter(n => n.kind === 'workspace').map(function(n) {
        const r = 6 + Math.min(8, n.weight * 0.3);
        return '<g><circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) +
               '" r="' + r.toFixed(1) + '" fill="var(--vscode-charts-orange,#ce9178)" />' +
               '<text class="label" x="' + (n.x + r + 4).toFixed(1) + '" y="' + (n.y + 4).toFixed(1) +
               '">' + esc(n.note) + '</text></g>';
      }).join('');
      const svg = '<svg viewBox="0 0 ' + String(W) + ' ' + String(H) +
                  '" width="' + String(W) + '" height="' + String(H) +
                  '">' + lines + machines + workspaces + '</svg>';
      document.getElementById('graph').innerHTML = svg;
    }
    window.addEventListener('message', function(ev) {
      if (ev.data && ev.data.type === 'graph' && ev.data.graph) {
        render(ev.data.graph);
      }
    });
    document.getElementById('btnRefresh').addEventListener('click', function() {
      vscode.postMessage({ type: 'refresh' });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

async function pushGraph(wv: vscode.Webview, storageDir: string): Promise<void> {
  const file = await loadActivityFile(storageDir);
  const graph: MachineGraph = buildMachineGraph(file.events, {
    width: W,
    height: H,
    minWeight: 1,
    windowMs: 30 * 24 * 3600_000,
  });
  await wv.postMessage({ type: "graph", graph });
}

export function openMachineGraphPanel(context: vscode.ExtensionContext, storageDir: string): void {
  lastStorageDir = storageDir;
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      WEBVIEW_VIEW_TYPE,
      "VSCodeSync · Machines",
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
          await pushGraph(panel.webview, dir);
        }
      },
      undefined,
      context.subscriptions,
    );
  }
  panel.reveal(vscode.ViewColumn.One, false);
  const wv = panel.webview;
  wv.html = buildHtml(getWebviewNonce(), wv.cspSource);
  void pushGraph(wv, storageDir);
}
