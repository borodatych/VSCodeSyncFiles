import * as vscode from "vscode";
import { getWebviewNonce } from "../utils/webviewNonce.js";
import * as fs from "node:fs/promises";
import type { ActivityEvent } from "../core/activityLog.js";
import { loadActivityFile } from "../core/activityLog.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { PathMappingError, trackedLocalAbsolutePath } from "../core/pathMapping.js";
import type { ActivityFilter } from "./activityFilterMatch.js";

const WEBVIEW_VIEW_TYPE = "vscodesyncActivityFeed";


function eventsToCsv(events: ActivityEvent[]): string {
  const head = ["at", "kind", "workspaceId", "workspaceNote", "relPath", "machineName", "provider", "detail"];
  const lines = [head.join(",")];
  for (const e of events) {
    const row = [e.at, e.kind, e.workspaceId, e.workspaceNote, e.relPath, e.machineName, e.provider, e.detail ?? ""].map(
      (c) => {
        const t = c.replace(/"/g, '""');
        return `"${t}"`;
      },
    );
    lines.push(row.join(","));
  }
  return `${lines.join("\n")}\n`;
}

function buildHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'" />
  <title>VSCodeSync Activity</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px; margin: 0; }
    h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 12px 0; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    label { margin-right: 4px; opacity: 0.9; }
    select, input[type="search"], button {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      padding: 4px 8px;
      border-radius: 2px;
    }
    button { cursor: pointer; }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, #333); vertical-align: top; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 1; }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
    .muted { opacity: 0.75; font-size: 0.9em; }
    .badge { font-size: 0.85em; padding: 1px 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 4px; }
    .k-push { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
    .k-pull { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .k-conflict { color: var(--vscode-errorForeground); }
    .file-link { cursor: pointer; color: var(--vscode-textLink-foreground); text-decoration: underline; }
    .file-link:focus { outline: 1px solid var(--vscode-focusBorder); }
    .act-btns { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .act-btns button { font-size: 0.9em; padding: 2px 6px; }
  </style>
</head>
<body>
  <h1>Activity Feed</h1>
  <div class="row">
    <label>Workspace</label>
    <select id="fWs"><option value="">(все)</option></select>
    <label>Машина</label>
    <select id="fMachine"><option value="">(все)</option></select>
    <label>Тип</label>
    <select id="fKind">
      <option value="">(все)</option>
      <option value="push">push</option>
      <option value="pull">pull</option>
      <option value="conflict">конфликт</option>
      <option value="add">добавлен</option>
      <option value="remove">удалён</option>
      <option value="resolve_keep_mine">resolve keep mine</option>
      <option value="resolve_take_theirs">resolve take theirs</option>
    </select>
    <label>Поиск пути</label>
    <input type="search" id="fPath" placeholder="фрагмент пути…" />
    <button type="button" id="btnRefresh">Обновить</button>
    <button type="button" id="btnCsv">Экспорт CSV</button>
    <button type="button" id="btnJson">Экспорт JSON</button>
    <button type="button" id="btnJsonl">Экспорт JSONL</button>
  </div>
  <div id="summary" class="muted"></div>
  <table>
    <thead><tr><th>Время</th><th>Тип</th><th>Файл</th><th>Workspace</th><th>Действия</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let allEvents = [];

    function kindClass(k) {
      if (k === 'push') return 'k-push';
      if (k === 'pull') return 'k-pull';
      if (k === 'conflict') return 'k-conflict';
      return '';
    }

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function extraBadges(ev) {
      const parts = [];
      if (ev.meta && ev.meta.pushOnCommit) {
        parts.push('<span class="badge">on commit</span>');
      }
      if (ev.meta && ev.meta.autoResolved && ev.meta.rule) {
        parts.push('<span class="badge">⚡ auto-resolved (rule: ' + esc(String(ev.meta.rule)) + ')</span>');
      }
      if (ev.detail) {
        parts.push('<span class="badge">' + esc(ev.detail) + '</span>');
      }
      return parts.join(' ');
    }

    function populateFilters() {
      const ws = document.getElementById('fWs');
      const ms = document.getElementById('fMachine');
      const wsVal = ws.value;
      const mVal = ms.value;
      const wss = [...new Set(allEvents.map(function (e) { return e.workspaceId; }))].sort();
      const machines = [...new Set(allEvents.map(function (e) { return e.machineName; }))].sort();
      ws.innerHTML = '<option value="">(все)</option>' + wss.map(function (id) {
        var note = '';
        for (var i = 0; i < allEvents.length; i++) {
          if (allEvents[i].workspaceId === id) { note = allEvents[i].workspaceNote || ''; break; }
        }
        var lab = note ? (note + ' · ' + id.slice(0, 8)) : id;
        return '<option value="' + esc(id) + '">' + esc(lab) + '</option>';
      }).join('');
      ms.innerHTML = '<option value="">(все)</option>' + machines.map(function (m) {
        return '<option value="' + esc(m) + '">' + esc(m) + '</option>';
      }).join('');
      ws.value = wss.indexOf(wsVal) >= 0 ? wsVal : '';
      ms.value = machines.indexOf(mVal) >= 0 ? mVal : '';
    }

    function filtered() {
      var ws = document.getElementById('fWs').value;
      var machine = document.getElementById('fMachine').value;
      var kind = document.getElementById('fKind').value;
      var pathQ = document.getElementById('fPath').value.trim().toLowerCase();
      return allEvents.filter(function (e) {
        if (ws && e.workspaceId !== ws) return false;
        if (machine && e.machineName !== machine) return false;
        if (kind && e.kind !== kind) return false;
        if (pathQ && e.relPath.toLowerCase().indexOf(pathQ) < 0) return false;
        return true;
      });
    }

    function render() {
      populateFilters();
      var evs = filtered().slice().reverse();
      document.getElementById('summary').textContent = 'Показано ' + String(evs.length) + ' из ' + String(allEvents.length) + ' записей.';
      var tb = document.getElementById('tbody');
      tb.innerHTML = evs.map(function (e) {
        var when = esc(e.at);
        var k = esc(e.kind);
        var kc = kindClass(e.kind);
        var w = esc(e.workspaceId);
        var p = esc(e.relPath);
        var fileLink = '<span class="file-link" role="button" tabindex="0" data-open="' + w + '" data-path="' + p + '" title="Открыть файл">' + p + '</span>';
        var wsn = esc(e.workspaceNote || e.workspaceId);
        var act = '<div class="act-btns">' +
          '<button type="button" data-open="' + w + '" data-path="' + p + '">Открыть</button>' +
          '<button type="button" data-diff="' + w + '" data-path="' + p + '">С облаком</button>' +
          '<button type="button" data-hist="' + w + '" data-path="' + p + '">История</button>' +
          '</div>';
        return '<tr><td class="muted">' + when + '</td><td class="' + kc + '">' + k + '</td><td>' + fileLink + '<div class="muted">' + extraBadges(e) + '</div></td><td>' + wsn + '</td><td>' + act + '</td></tr>';
      }).join('');
      function postOpen(wsId, rel) {
        vscode.postMessage({ type: 'openFile', workspaceId: wsId, relPath: rel });
      }
      function bindOpen(el) {
        var wsId = el.getAttribute('data-open');
        var rel = el.getAttribute('data-path');
        if (!wsId || !rel) return;
        el.addEventListener('click', function () { postOpen(wsId, rel); });
        el.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            postOpen(wsId, rel);
          }
        });
      }
      tb.querySelectorAll('.file-link').forEach(bindOpen);
      tb.querySelectorAll('button[data-open]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          postOpen(btn.getAttribute('data-open'), btn.getAttribute('data-path'));
        });
      });
      tb.querySelectorAll('button[data-diff]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          vscode.postMessage({
            type: 'diffCloud',
            workspaceId: btn.getAttribute('data-diff'),
            relPath: btn.getAttribute('data-path'),
          });
        });
      });
      tb.querySelectorAll('button[data-hist]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          vscode.postMessage({
            type: 'showHistory',
            workspaceId: btn.getAttribute('data-hist'),
            relPath: btn.getAttribute('data-path'),
          });
        });
      });
    }

    window.addEventListener('message', function (ev) {
      if (ev.data && ev.data.type === 'load') {
        allEvents = ev.data.events || [];
        render();
      }
      if (ev.data && ev.data.type === 'applySavedSearch' && ev.data.filter) {
        var f = ev.data.filter;
        document.getElementById('fWs').value = f.workspaceId || '';
        document.getElementById('fKind').value = f.kind || '';
        document.getElementById('fPath').value = f.query || '';
        render();
      }
    });

    function notifyFilterChanged() {
      vscode.postMessage({
        type: 'filterChanged',
        filter: {
          workspaceId: document.getElementById('fWs').value || undefined,
          kind: document.getElementById('fKind').value || undefined,
          query: document.getElementById('fPath').value.trim() || undefined,
        },
      });
    }

    ['fWs', 'fMachine', 'fKind', 'fPath'].forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener('change', function () { render(); notifyFilterChanged(); });
      el.addEventListener('input', function () {
        if (id === 'fPath') { render(); notifyFilterChanged(); }
      });
    });
    document.getElementById('btnRefresh').addEventListener('click', function () {
      vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('btnCsv').addEventListener('click', function () {
      vscode.postMessage({ type: 'export', format: 'csv', events: filtered() });
    });
    document.getElementById('btnJson').addEventListener('click', function () {
      vscode.postMessage({ type: 'export', format: 'json', events: filtered() });
    });
    document.getElementById('btnJsonl').addEventListener('click', function () {
      vscode.postMessage({ type: 'export', format: 'jsonl', events: filtered() });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

async function resolveTrackedFileUri(
  workspaceId: string,
  relPath: string,
  machineName: string,
): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  for (const f of folders) {
    const root = f.uri.fsPath;
    const wc = await WorkspaceConfigManager.load(root);
    if (!wc.activeWorkspaces.some((w) => w.workspaceId === workspaceId)) {
      continue;
    }
    const abs = trackedLocalAbsolutePath(root, wc.pathMapping, machineName, relPath);
    return vscode.Uri.file(abs);
  }
  return undefined;
}

let panel: vscode.WebviewPanel | undefined;

/** Set on each open; the singleton webview handler reads the latest dir. */
let lastActivityStorageDir: string | undefined;
let lastActivityMachineName = "";
let lastFilterChangedHandler: ((filter: ActivityFilter) => void) | undefined;

export interface OpenActivityFeedOptions {
  /** When set, the webview applies this filter on load (saved-search flow). */
  applyFilter?: ActivityFilter;
  /** Called when the user changes the form filter — host persists for "save current search". */
  onFilterChanged?: (filter: ActivityFilter) => void;
}

export function openActivityFeedPanel(
  context: vscode.ExtensionContext,
  storageDir: string,
  machineName: string,
  options?: OpenActivityFeedOptions,
): void {
  lastActivityStorageDir = storageDir;
  lastActivityMachineName = machineName;
  lastFilterChangedHandler = options?.onFilterChanged;

  if (!panel) {
    panel = vscode.window.createWebviewPanel(WEBVIEW_VIEW_TYPE, "VSCodeSync · Activity Feed", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(
      () => {
        panel = undefined;
      },
      null,
      context.subscriptions,
    );

    panel.webview.onDidReceiveMessage(
      async (msg: {
        type: string;
        format?: string;
        events?: ActivityEvent[];
        workspaceId?: string;
        relPath?: string;
        filter?: ActivityFilter;
      }) => {
        const dir = lastActivityStorageDir;
        const wv = panel?.webview;
        const machine = lastActivityMachineName;
        if (!dir || !wv) {
          return;
        }
        const pushEvents = async (): Promise<void> => {
          const data = await loadActivityFile(dir);
          await wv.postMessage({ type: "load", events: data.events });
        };

        if (msg.type === "ready" || msg.type === "refresh") {
          await pushEvents();
          return;
        }
        if (msg.type === "filterChanged" && msg.filter) {
          lastFilterChangedHandler?.(msg.filter);
          return;
        }
        if (msg.type === "openFile" && msg.workspaceId && msg.relPath) {
          try {
            const uri = await resolveTrackedFileUri(msg.workspaceId, msg.relPath, machine);
            if (uri) {
              await vscode.window.showTextDocument(uri);
            } else {
              await vscode.window.showWarningMessage(
                "VSCodeSync: не найден открытый проект с этим workspace — откройте папку, где подключён тот же workspaceId.",
              );
            }
          } catch (e) {
            if (e instanceof PathMappingError) {
              await vscode.window.showWarningMessage(`VSCodeSync: ${e instanceof Error ? e.message : String(e)}`);
              return;
            }
            throw e;
          }
          return;
        }
        if (msg.type === "diffCloud" && msg.workspaceId && msg.relPath) {
          try {
            const uri = await resolveTrackedFileUri(msg.workspaceId, msg.relPath, machine);
            if (uri) {
              await vscode.commands.executeCommand("vscodesync.diffWithCloud", uri);
            } else {
              await vscode.window.showWarningMessage(
                "VSCodeSync: не удалось открыть diff — нет подходящей папки workspace.",
              );
            }
          } catch (e) {
            if (e instanceof PathMappingError) {
              await vscode.window.showWarningMessage(`VSCodeSync: ${e instanceof Error ? e.message : String(e)}`);
              return;
            }
            throw e;
          }
          return;
        }
        if (msg.type === "showHistory" && msg.workspaceId && msg.relPath) {
          try {
            const uri = await resolveTrackedFileUri(msg.workspaceId, msg.relPath, machine);
            if (uri) {
              await vscode.commands.executeCommand("vscodesync.showFileHistory", uri);
            } else {
              await vscode.window.showWarningMessage(
                "VSCodeSync: не удалось открыть историю — нет подходящей папки workspace.",
              );
            }
          } catch (e) {
            if (e instanceof PathMappingError) {
              await vscode.window.showWarningMessage(`VSCodeSync: ${e instanceof Error ? e.message : String(e)}`);
              return;
            }
            throw e;
          }
          return;
        }
        if (msg.type === "export" && msg.format && Array.isArray(msg.events)) {
          const evs = msg.events;
          let body: string;
          let ext: string;
          if (msg.format === "csv") {
            body = eventsToCsv(evs);
            ext = "csv";
          } else if (msg.format === "json") {
            body = `${JSON.stringify({ schema: 1, events: evs }, null, 2)}\n`;
            ext = "json";
          } else {
            body = evs.map((e) => JSON.stringify(e)).join("\n") + (evs.length ? "\n" : "");
            ext = "jsonl";
          }
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`vscodesync-activity-export.${ext}`),
            filters: { Export: [ext] },
          });
          if (uri) {
            await fs.writeFile(uri.fsPath, body, "utf8");
            void vscode.window.showInformationMessage(`VSCodeSync: экспорт сохранён — ${uri.fsPath}`);
          }
        }
      },
      undefined,
      context.subscriptions,
    );
  }

  panel.reveal(vscode.ViewColumn.One, false);

  const nonce = getWebviewNonce();
  const wv = panel.webview;
  wv.html = buildHtml(nonce, wv.cspSource);

  void (async () => {
    const data = await loadActivityFile(storageDir);
    await wv.postMessage({ type: "load", events: data.events });
    if (options?.applyFilter) {
      await wv.postMessage({ type: "applySavedSearch", filter: options.applyFilter });
    }
  })();
}
