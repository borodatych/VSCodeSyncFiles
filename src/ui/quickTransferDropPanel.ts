/**
 * Quick Transfer drop-zone webview — a single-panel UI for one-shot file
 * transfers. The webview shows a list of recently-edited files in the open
 * workspace folders; clicking one (or pressing Send) routes through the
 * existing `vscodesync.sendQuickTransfer` command.
 *
 * VS Code webviews don't receive real file URIs through HTML5 drag-and-drop
 * for security reasons, so we don't try — the panel exists as a quick
 * one-pane alternative to the palette command, with target-machine picking
 * still done by the underlying command.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { getWebviewNonce } from "../utils/webviewNonce.js";

const WEBVIEW_VIEW_TYPE = "vscodesyncQuickTransferDrop";

let panel: vscode.WebviewPanel | undefined;

interface RecentFile {
  fsPath: string;
  rel: string;
  mtimeMs: number;
}

function buildHtml(n: string, csp: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${n}'" />
  <title>VSCodeSync · Quick Transfer</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 14px; margin: 0; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 6px 0; }
    p.muted { opacity: 0.75; font-size: 0.9em; margin: 4px 0 12px 0; }
    .drop-zone { border: 2px dashed var(--vscode-input-border, #555); border-radius: 6px; padding: 24px 16px; text-align: center; opacity: 0.85; margin-bottom: 14px; }
    .drop-zone.hot { background: var(--vscode-list-hoverBackground); opacity: 1; }
    .drop-zone code { font-size: 0.85em; opacity: 0.8; }
    .recent { margin-top: 6px; }
    .recent .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
    .recent .row:hover { background: var(--vscode-list-hoverBackground); }
    .recent .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .recent .when { font-size: 0.85em; opacity: 0.7; min-width: 80px; text-align: right; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 12px; border-radius: 2px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h1>VSCodeSync · Quick Transfer</h1>
  <p class="muted">Одноразовая передача файла на другую машину. Файл хранится в облаке до <code>quickTransferTtlDays</code> дней.</p>
  <div class="drop-zone" id="dz">
    <div>📤 Перетащите файл из Explorer на иконку расширения, либо выберите ниже</div>
    <div style="margin-top:8px"><button type="button" id="btnPick">Выбрать файл…</button></div>
    <div class="muted" style="margin-top:8px"><code>VSCodeSync: Send file (Quick Transfer)</code> в палитре делает то же самое.</div>
  </div>
  <h1 style="font-size:0.95rem">Недавние файлы</h1>
  <div class="recent" id="rec"></div>

  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function fmtAge(mtimeMs) {
      const dt = Date.now() - mtimeMs;
      if (dt < 60_000) return 'только что';
      if (dt < 3600_000) return Math.floor(dt / 60_000) + ' мин';
      if (dt < 86_400_000) return Math.floor(dt / 3600_000) + ' ч';
      return Math.floor(dt / 86_400_000) + ' д';
    }
    function render(files) {
      const root = document.getElementById('rec');
      if (!files || files.length === 0) {
        root.innerHTML = '<div class="muted" style="padding:6px 8px">Нет недавно изменённых файлов в открытых папках.</div>';
        return;
      }
      root.innerHTML = files.map(function(f) {
        return '<div class="row">' +
          '<div class="name" title="' + esc(f.fsPath) + '">' + esc(f.rel) + '</div>' +
          '<div class="when">' + fmtAge(f.mtimeMs) + '</div>' +
          '<button type="button" data-path="' + esc(f.fsPath) + '">Send</button>' +
          '</div>';
      }).join('');
      root.querySelectorAll('button[data-path]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          vscode.postMessage({ type: 'send', fsPath: btn.getAttribute('data-path') });
        });
      });
    }
    document.getElementById('btnPick').addEventListener('click', function() {
      vscode.postMessage({ type: 'pickAndSend' });
    });
    var dz = document.getElementById('dz');
    ['dragenter', 'dragover'].forEach(function(t) {
      dz.addEventListener(t, function(e) { e.preventDefault(); dz.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function(t) {
      dz.addEventListener(t, function(e) { e.preventDefault(); dz.classList.remove('hot'); });
    });
    window.addEventListener('message', function(ev) {
      if (ev.data && ev.data.type === 'recent') {
        render(ev.data.files || []);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

const RECENT_WINDOW_MS = 24 * 3600_000;
const RECENT_LIMIT = 12;

async function gatherRecentFiles(): Promise<RecentFile[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const out: RecentFile[] = [];
  const now = Date.now();
  for (const folder of folders) {
    // findFiles with default ignore rules — capped per folder for responsiveness.
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*"),
      "**/{node_modules,dist,.git,.vscode-test,.vscode}/**",
      RECENT_LIMIT * 4,
    );
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (now - stat.mtime > RECENT_WINDOW_MS) continue;
        out.push({
          fsPath: uri.fsPath,
          rel: path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/"),
          mtimeMs: stat.mtime,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, RECENT_LIMIT);
}

async function pickAndSend(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: "VSCodeSync · выбрать файл для Quick Transfer",
  });
  if (!picked || picked.length === 0) return;
  await vscode.commands.executeCommand("vscodesync.sendQuickTransfer", picked[0]);
}

export function openQuickTransferDropPanel(context: vscode.ExtensionContext): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      WEBVIEW_VIEW_TYPE,
      "VSCodeSync · Quick Transfer",
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
      async (msg: { type?: string; fsPath?: string }) => {
        if (msg.type === "ready") {
          if (!panel) return;
          const files = await gatherRecentFiles();
          await panel.webview.postMessage({ type: "recent", files });
        } else if (msg.type === "pickAndSend") {
          await pickAndSend();
        } else if (msg.type === "send" && msg.fsPath) {
          await vscode.commands.executeCommand(
            "vscodesync.sendQuickTransfer",
            vscode.Uri.file(msg.fsPath),
          );
        }
      },
      undefined,
      context.subscriptions,
    );
  }
  panel.reveal(vscode.ViewColumn.One, false);
  const wv = panel.webview;
  wv.html = buildHtml(getWebviewNonce(), wv.cspSource);
}
