/**
 * The «Расхождения» panel — the single point of action for 1.0.0 (stage 3.5).
 *
 * Automatic sources stopped moving files in stage 3; this is where the user
 * sees what differs and decides. It shows only what the detector already
 * recorded in `syncStatus`, so opening it costs no cloud traffic — refreshing
 * is an explicit button.
 *
 * Two deliberate properties:
 *
 * - **Singleton.** A second `createWebviewPanel` would silently orphan the
 *   first one's listeners; `settingsPanel.ts` does exactly that (finding F8).
 *   Here the panel is revealed, not recreated, and its subscriptions live in a
 *   local array released on dispose rather than in `context.subscriptions`.
 * - **Closed message protocol.** `commandCenter.ts` and `settingsPanel.ts`
 *   accept `executeCommand(msg.command, ...msg.args)` from the webview with no
 *   allow-list — any script reaching the channel runs any command. This panel
 *   accepts a fixed set of message kinds, validates every field, and never
 *   takes a command id from the page.
 */
import * as vscode from "vscode";
import { getWebviewNonce } from "../utils/webviewNonce.js";
import { getWebviewKindDescriptor } from "../core/webviewPanelKindRegistry.js";
import {
  DIVERGENCE_KEY_SEP,
  describeDivergenceCounts,
  divergenceRowKey,
  parseDivergenceRequest,
  summariseDivergences,
  type DivergenceGroup,
  type DivergenceRow,
} from "../core/divergencePlan.js";


export interface DivergencePanelHandlers {
  /** Recompute statuses (detector pass) and return the fresh plan. */
  refresh: () => Promise<DivergenceGroup[]>;
  /** Run the bulk action over the selected rows; returns a short report line. */
  bulk: (direction: "push" | "pull", rows: DivergenceRow[]) => Promise<string>;
  /** Open a diff for one row. */
  compare: (row: DivergenceRow) => Promise<void>;
  /** Offer the conflict resolution choices for one row. */
  resolve: (row: DivergenceRow) => Promise<void>;
  /** Link Bindings: placement chooser for a row absent on disk. */
  bind: (row: DivergenceRow) => Promise<void>;
}

let panel: vscode.WebviewPanel | undefined;
/** Subscriptions owned by the live panel; released on dispose, not on unload. */
let panelSubscriptions: vscode.Disposable[] = [];
let currentGroups: DivergenceGroup[] = [];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(nonce: string, cspSource: string): string {
  const d = getWebviewKindDescriptor("divergences");
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'" />
  <title>${escapeHtml(d.title)}</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 14px; margin: 0; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 2px 0; }
    .muted { opacity: 0.75; font-size: 0.9em; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0 12px 0; }
    .chips { display: flex; gap: 4px; }
    .chip { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border: 1px solid transparent; border-radius: 10px; padding: 2px 10px; cursor: pointer; font-size: 0.85em; }
    .chip[aria-pressed="true"] { border-color: var(--vscode-focusBorder); font-weight: 600; }
    .spacer { flex: 1; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 12px; border-radius: 2px; cursor: pointer; font-size: 0.9em; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.45; cursor: default; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .group { margin-bottom: 16px; }
    .group > header { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--vscode-widget-border, #333); }
    .group h2 { font-size: 0.95rem; font-weight: 600; margin: 0; }
    .badge { font-size: 0.8em; opacity: 0.8; }
    .susp { color: var(--vscode-editorWarning-foreground); font-size: 0.8em; }
    .row { display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-bottom: 1px solid var(--vscode-widget-border, #2a2a2a); }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    /* State, not an action. Deliberately unlike a button: no frame, muted,
       small caps and a leading dot — users clicked it expecting a download. */
    .row .dir {
      min-width: 104px; font-size: 0.75em; letter-spacing: .04em;
      text-transform: uppercase; opacity: .65; cursor: default; user-select: none;
    }
    .row .dir::before { content: "• "; }
    .row .dir.conflict { color: var(--vscode-editorError-foreground); opacity: .9; }
    .row .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .reason { font-size: 0.82em; opacity: 0.7; min-width: 170px; }
    .row .acts { display: flex; gap: 4px; }
    .row .acts button { padding: 2px 8px; font-size: 0.8em; }
    .row .acts button.secondary {
      background: transparent; color: var(--vscode-foreground);
      border: 1px solid var(--vscode-button-secondaryBackground, var(--vscode-panel-border)); opacity: .8;
    }
    .row .acts button.secondary:hover:not(:disabled) { opacity: 1; }
    .empty { padding: 24px 4px; opacity: 0.75; }
    .busy { opacity: 0.55; pointer-events: none; }
  </style>
</head>
<body>
  <h1>Расхождения</h1>
  <div class="muted" id="sub">Загрузка…</div>

  <div class="toolbar">
    <div class="chips" id="chips">
      <button type="button" class="chip" data-f="all" aria-pressed="true">Все</button>
      <button type="button" class="chip" data-f="push" aria-pressed="false">↑ отправить</button>
      <button type="button" class="chip" data-f="pull" aria-pressed="false">↓ скачать</button>
      <button type="button" class="chip" data-f="conflict" aria-pressed="false">⚠ конфликты</button>
    </div>
    <div class="spacer"></div>
    <button type="button" id="btnPush" disabled>Отправить выбранные</button>
    <button type="button" id="btnPull" disabled>Скачать выбранные</button>
    <button type="button" class="secondary" id="btnRefresh">Обновить</button>
  </div>

  <div id="list"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let groups = [];
    let filter = 'all';
    const selected = new Set();

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    const SEP = ${JSON.stringify(DIVERGENCE_KEY_SEP)};
    function keyOf(r) { return [r.root, r.workspaceId, r.posixRel].join(SEP); }
    function visibleGroups() {
      if (filter === 'all') return groups;
      return groups
        .map(function (g) { return Object.assign({}, g, { rows: g.rows.filter(function (r) { return r.direction === filter; }) }); })
        .filter(function (g) { return g.rows.length > 0; });
    }
    function dirLabel(d) {
      return d === 'push' ? '↑ отправить' : d === 'pull' ? '↓ скачать' : '⚠ конфликт';
    }
    function updateButtons() {
      var pushable = 0, pullable = 0;
      groups.forEach(function (g) {
        if (g.suspended) return;
        g.rows.forEach(function (r) {
          if (!selected.has(keyOf(r))) return;
          if (r.direction === 'push') pushable++;
          if (r.direction === 'pull') pullable++;
        });
      });
      document.getElementById('btnPush').disabled = pushable === 0;
      document.getElementById('btnPull').disabled = pullable === 0;
    }
    function render() {
      var vis = visibleGroups();
      var list = document.getElementById('list');
      if (vis.length === 0) {
        list.innerHTML = '<div class="empty">' +
          (groups.length === 0
            ? 'Расхождений нет — локальное состояние совпадает с облаком.'
            : 'Под выбранный фильтр ничего не подходит.') + '</div>';
        updateButtons();
        return;
      }
      list.innerHTML = vis.map(function (g) {
        var head = '<header>' +
          '<input type="checkbox" data-grp="' + esc(g.workspaceId) + '" data-root="' + esc(g.root) + '" />' +
          '<h2>' + esc(g.workspaceNote) + '</h2>' +
          '<span class="badge">' + g.rows.length + '</span>' +
          (g.suspended ? '<span class="susp">приостановлен — действия недоступны</span>' : '') +
          '</header>';
        var rows = g.rows.map(function (r) {
          var k = keyOf(r);
          // Per-row actions. The direction the row already wants is primary;
          // the opposite one is offered too (the user may deliberately
          // overwrite) but marked as secondary and confirmed on the host side.
          var rowActs = r.direction === 'conflict'
            ? '<button type="button" data-act="resolve" data-key="' + esc(k) + '">Разрешить</button>'
            : (r.direction === 'pull'
                ? '<button type="button" class="primary" data-act="pull" data-key="' + esc(k) + '">↓ Скачать</button>' +
                  '<button type="button" class="secondary" data-act="push" data-key="' + esc(k) + '" title="Отправить локальную версию поверх более новой облачной">↑ Отправить</button>'
                : '<button type="button" class="primary" data-act="push" data-key="' + esc(k) + '">↑ Отправить</button>' +
                  '<button type="button" class="secondary" data-act="pull" data-key="' + esc(k) + '" title="Скачать облачную версию поверх локальных изменений">↓ Скачать</button>');
          var acts = rowActs +
            '<button type="button" data-act="compare" data-key="' + esc(k) + '">Сравнить</button>' +
            (r.missingLocal
              ? '<button type="button" data-act="bind" data-key="' + esc(k) + '">Привязать…</button>'
              : '');
          return '<div class="row">' +
            '<input type="checkbox" data-key="' + esc(k) + '"' +
              (selected.has(k) ? ' checked' : '') + (g.suspended ? ' disabled' : '') + ' />' +
            '<span class="dir ' + esc(r.direction) + '">' + esc(dirLabel(r.direction)) + '</span>' +
            '<span class="path" title="' + esc(r.posixRel) + '">' + esc(r.posixRel) + '</span>' +
            '<span class="reason">' + esc(r.reason) +
              (r.editingByName ? ' · ' + esc(r.editingByName) : '') + '</span>' +
            '<span class="acts">' + acts + '</span>' +
            '</div>';
        }).join('');
        return '<div class="group">' + head + rows + '</div>';
      }).join('');
      updateButtons();
    }
    function selectedKeys() { return Array.from(selected); }

    document.getElementById('chips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      filter = b.getAttribute('data-f');
      Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
        c.setAttribute('aria-pressed', String(c === b));
      });
      render();
    });
    document.getElementById('list').addEventListener('change', function (e) {
      var t = e.target;
      if (t.tagName !== 'INPUT') return;
      var grp = t.getAttribute('data-grp');
      if (grp !== null) {
        var root = t.getAttribute('data-root');
        var g = groups.find(function (x) { return x.workspaceId === grp && x.root === root; });
        if (g && !g.suspended) {
          g.rows.forEach(function (r) {
            if (filter !== 'all' && r.direction !== filter) return;
            if (t.checked) selected.add(keyOf(r)); else selected.delete(keyOf(r));
          });
        }
        render();
        return;
      }
      var k = t.getAttribute('data-key');
      if (k === null) return;
      if (t.checked) selected.add(k); else selected.delete(k);
      updateButtons();
    });
    document.getElementById('list').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      var key = b.getAttribute('data-key');
      if (act === 'push' || act === 'pull') {
        vscode.postMessage({ kind: 'row', direction: act, key: key });
        return;
      }
      vscode.postMessage({ kind: act, key: key });
    });
    document.getElementById('btnPush').addEventListener('click', function () {
      vscode.postMessage({ kind: 'bulk', direction: 'push', keys: selectedKeys() });
    });
    document.getElementById('btnPull').addEventListener('click', function () {
      vscode.postMessage({ kind: 'bulk', direction: 'pull', keys: selectedKeys() });
    });
    document.getElementById('btnRefresh').addEventListener('click', function () {
      document.body.classList.add('busy');
      vscode.postMessage({ kind: 'refresh' });
    });

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg || msg.kind !== 'state') return;
      groups = msg.groups || [];
      document.body.classList.remove('busy');
      // Drop selections whose rows no longer exist, keep the rest.
      var live = new Set();
      groups.forEach(function (g) { g.rows.forEach(function (r) { live.add(keyOf(r)); }); });
      Array.from(selected).forEach(function (k) { if (!live.has(k)) selected.delete(k); });
      document.getElementById('sub').textContent = msg.summary;
      render();
    });

    vscode.postMessage({ kind: 'refresh' });
  </script>
</body>
</html>`;
}

/** Every row currently displayed, by key — the panel's own index. */
function indexRows(groups: readonly DivergenceGroup[]): Map<string, DivergenceRow> {
  const map = new Map<string, DivergenceRow>();
  for (const g of groups) {
    for (const r of g.rows) {
      map.set(divergenceRowKey(r), r);
    }
  }
  return map;
}


function postState(target: vscode.WebviewPanel, groups: readonly DivergenceGroup[]): void {
  const counts = summariseDivergences(groups);
  void target.webview.postMessage({
    kind: "state",
    groups,
    summary:
      counts.total === 0
        ? "Локальное состояние совпадает с облаком."
        : `${describeDivergenceCounts(counts)} — всего ${String(counts.total)}. Ничего не выполняется без вашей команды.`,
  });
}

/** Push a freshly computed plan into the open panel, if any. */
export function updateDivergencePanel(groups: DivergenceGroup[]): void {
  currentGroups = groups;
  if (panel) {
    postState(panel, groups);
  }
}

export function openDivergencePanel(handlers: DivergencePanelHandlers): void {
  const descriptor = getWebviewKindDescriptor("divergences");
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    descriptor.viewType,
    descriptor.title,
    vscode.ViewColumn.Active,
    {
      enableScripts: descriptor.enableScripts,
      enableCommandUris: descriptor.enableCommandUris,
      retainContextWhenHidden: descriptor.retainContextWhenHidden,
    },
  );
  const live = panel;
  const nonce = getWebviewNonce();
  live.webview.html = buildHtml(nonce, live.webview.cspSource);

  panelSubscriptions.push(
    live.webview.onDidReceiveMessage((raw: unknown) => {
      const req = parseDivergenceRequest(raw);
      if (req === null) {
        // Not an error path we can act on — record it and carry on.
        void vscode.window.showWarningMessage(
          "VSCodeSync: панель «Расхождения» получила нераспознанное сообщение и проигнорировала его.",
        );
        return;
      }
      void (async () => {
        try {
          if (req.kind === "refresh") {
            updateDivergencePanel(await handlers.refresh());
            return;
          }
          const index = indexRows(currentGroups);
          if (req.kind === "bulk") {
            const rows = req.keys
              .map((k) => index.get(k))
              .filter((r): r is DivergenceRow => r?.direction === req.direction);
            if (rows.length === 0) return;
            const report = await handlers.bulk(req.direction, rows);
            void vscode.window.showInformationMessage(report);
            updateDivergencePanel(await handlers.refresh());
            return;
          }
          if (req.kind === "row") {
            const target = index.get(req.key);
            if (target === undefined) return;
            // Acting against the detected direction overwrites the side that
            // is currently ahead — the one case in this panel where a single
            // click can lose work, so it asks first.
            if (target.direction !== req.direction) {
              const detail =
                req.direction === "push"
                  ? "В облаке лежит более новая версия. Отправка запишет поверх неё вашу локальную — облачные изменения будут потеряны."
                  : "Локально есть изменения. Скачивание запишет поверх них облачную версию — локальные изменения будут потеряны.";
              const go = await vscode.window.showWarningMessage(
                `VSCodeSync — ${target.posixRel}`,
                { modal: true, detail },
                req.direction === "push" ? "Всё равно отправить" : "Всё равно скачать",
              );
              if (go === undefined) return;
            }
            const report = await handlers.bulk(req.direction, [target]);
            void vscode.window.showInformationMessage(report);
            updateDivergencePanel(await handlers.refresh());
            return;
          }
          const row = index.get(req.key);
          if (row === undefined) return;
          if (req.kind === "compare") {
            await handlers.compare(row);
          } else if (req.kind === "bind") {
            await handlers.bind(row);
            updateDivergencePanel(await handlers.refresh());
          } else {
            await handlers.resolve(row);
            updateDivergencePanel(await handlers.refresh());
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          void vscode.window.showErrorMessage(`VSCodeSync: расхождения — ${msg}`);
          if (panel) postState(panel, currentGroups);
        }
      })();
    }),
    live.onDidDispose(() => {
      for (const d of panelSubscriptions) {
        d.dispose();
      }
      panelSubscriptions = [];
      panel = undefined;
      currentGroups = [];
    }),
  );
}

/** Test / deactivate hook: drop the singleton without going through VS Code. */
export function disposeDivergencePanel(): void {
  panel?.dispose();
}
