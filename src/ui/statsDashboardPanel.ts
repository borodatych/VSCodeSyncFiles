import * as vscode from "vscode";
import { getWebviewNonce } from "../utils/webviewNonce.js";
import type { StatsDashboardPayload } from "../core/statsDashboardModel.js";
import { buildStatsDashboardPayload } from "../core/statsDashboardModel.js";
import { loadActivityFile } from "../core/activityLog.js";
import { loadStatsFile } from "../core/syncStatsStore.js";
import { bucketActivity } from "./activityHeatmap.js";

const WEBVIEW_VIEW_TYPE = "vscodesyncStatsDashboard";


function buildHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'" />
  <title>VSCodeSync Stats</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px; margin: 0; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 8px 0; }
    h2 { font-size: 1rem; font-weight: 600; margin: 20px 0 8px 0; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
    .muted { opacity: 0.8; font-size: 0.9em; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin: 8px 0; }
    .card { background: var(--vscode-editor-inactiveSelectionBackground, rgba(120,120,120,0.15)); padding: 10px 12px; border-radius: 4px; }
    .card .val { font-size: 1.35rem; font-weight: 600; }
    .card .lbl { font-size: 0.85em; opacity: 0.85; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 0.95em; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
    .bars { display: flex; align-items: flex-end; gap: 3px; height: 120px; margin-top: 10px; overflow-x: auto; }
    .barwrap { flex: 1; min-width: 8px; display: flex; flex-direction: column; align-items: center; }
    .bar { width: 100%; background: var(--vscode-charts-green, #73c991); border-radius: 2px 2px 0 0; min-height: 2px; }
    .bardate { font-size: 0.65em; margin-top: 4px; opacity: 0.7; writing-mode: vertical-rl; transform: rotate(180deg); max-height: 48px; overflow: hidden; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 2px;
      cursor: pointer;
      margin-bottom: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .warn { color: var(--vscode-errorForeground); }
    .ok { color: var(--vscode-testing-iconPassed, #73c991); }
    .heatGrid { display: flex; flex-direction: column; gap: 2px; margin-top: 10px; font-size: 0.75em; }
    .heatRow { display: grid; grid-template-columns: 36px repeat(24, minmax(10px, 1fr)); gap: 1px; }
    .heatLabel { opacity: 0.8; padding-right: 6px; align-self: center; }
    .heatHour { text-align: center; opacity: 0.6; padding-bottom: 2px; }
    .heatCell { height: 14px; border-radius: 2px; background: rgba(73,194,143,0.05); }
  </style>
</head>
<body>
  <h1>Статистика VSCodeSync</h1>
  <p class="muted" id="sub">Загрузка…</p>
  <button type="button" id="btnRefresh">Обновить</button>

  <h2>Операции синхронизации</h2>
  <div class="grid">
    <div class="card"><div class="val" id="fWeek">—</div><div class="lbl">Событий синка (7 дн.)</div></div>
    <div class="card"><div class="val" id="fMonth">—</div><div class="lbl">Событий синка (30 дн.)</div></div>
    <div class="card"><div class="val" id="cResW">—</div><div class="lbl">Конфликтов разрешено (7 дн.)</div></div>
    <div class="card"><div class="val" id="cResM">—</div><div class="lbl">Конфликтов разрешено (30 дн.)</div></div>
  </div>

  <h2>Push / Pull</h2>
  <div class="grid">
    <div class="card"><div class="val" id="ppW">—</div><div class="lbl">Push / Pull (7 дн.)</div></div>
    <div class="card"><div class="val" id="ppM">—</div><div class="lbl">Push / Pull (30 дн.)</div></div>
  </div>

  <h2>Трафик (месяц <span id="monthKey"></span>)</h2>
  <div class="grid">
    <div class="card"><div class="val" id="upB">—</div><div class="lbl">Upload</div></div>
    <div class="card"><div class="val" id="dnB">—</div><div class="lbl">Download</div></div>
    <div class="card"><div class="val" id="savedC">—</div><div class="lbl">Экономия сжатия (оценка)</div></div>
    <div class="card"><div class="val" id="limB">—</div><div class="lbl">Лимит / использовано</div></div>
  </div>
  <p class="muted" id="compressNote"></p>

  <h2>Push/Pull по машинам (30 дн.)</h2>
  <table><thead><tr><th>Машина</th><th>Push</th><th>Pull</th></tr></thead><tbody id="machTb"></tbody></table>

  <h2>Топ файлов по числу синков (30 дн.)</h2>
  <table><thead><tr><th>Файл</th><th>Синков</th></tr></thead><tbody id="topTb"></tbody></table>

  <h2>Активность по дням (30 дн.)</h2>
  <div class="bars" id="bars"></div>

  <h2>Heatmap активности (час × день недели)</h2>
  <p class="muted">Цвет ячейки = относительная плотность синков в этот час недели.</p>
  <div class="heatGrid" id="heatGrid"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function fmtBytes(n) {
      if (n < 1024) return String(n) + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(2) + ' MB';
    }
    function render(p) {
      document.getElementById('sub').textContent =
        'Окна: скользящие 7 и 30 суток. Трафик — календарный месяц ' + p.trafficMonthKey + ' (локально).';
      document.getElementById('fWeek').textContent = String(p.filesSyncedWeek);
      document.getElementById('fMonth').textContent = String(p.filesSyncedMonth);
      document.getElementById('cResW').textContent = String(p.conflictsResolvedWeek);
      document.getElementById('cResM').textContent = String(p.conflictsResolvedMonth);
      document.getElementById('ppW').textContent = String(p.pushCountWeek) + ' / ' + String(p.pullCountWeek);
      document.getElementById('ppM').textContent = String(p.pushCountMonth) + ' / ' + String(p.pullCountMonth);
      document.getElementById('monthKey').textContent = p.trafficMonthKey;
      document.getElementById('upB').textContent = fmtBytes(p.bytesUploadedMonth);
      document.getElementById('dnB').textContent = fmtBytes(p.bytesDownloadedMonth);
      document.getElementById('savedC').textContent =
        p.compressUploadsEnabled ? fmtBytes(p.bytesCompressionSavedMonth) : '— (выкл.)';
      var totalMonth = p.bytesUploadedMonth + p.bytesDownloadedMonth;
      var lim = p.monthlyLimitMB;
      var limEl = document.getElementById('limB');
      if (lim <= 0) {
        limEl.textContent = 'без лимита';
        limEl.className = 'val';
      } else {
        var limBytes = lim * 1048576;
        var pct = limBytes > 0 ? Math.min(100, (totalMonth / limBytes) * 100) : 0;
        limEl.textContent = fmtBytes(totalMonth) + ' / ' + String(lim) + ' MB';
        limEl.className = 'val' + (pct >= 100 ? ' warn' : pct >= 85 ? ' warn' : ' ok');
      }
      var cn = document.getElementById('compressNote');
      if (p.compressUploadsEnabled && p.bytesCompressionSavedMonth === 0) {
        cn.textContent = 'Сжатие включено в настройках; дельта в движке пока не ведётся — счётчик экономии останется 0.';
      } else if (!p.compressUploadsEnabled) {
        cn.textContent = 'vscodesync.compressUploads выключен — экономия не считается.';
      } else {
        cn.textContent = '';
      }
      var mt = document.getElementById('machTb');
      mt.innerHTML = (p.pushPullByMachine || []).map(function (r) {
        return '<tr><td>' + esc(r.machine) + '</td><td>' + String(r.push) + '</td><td>' + String(r.pull) + '</td></tr>';
      }).join('');
      if (!p.pushPullByMachine || p.pushPullByMachine.length === 0) {
        mt.innerHTML = '<tr><td colspan="3" class="muted">Нет данных за 30 дн.</td></tr>';
      }
      var tt = document.getElementById('topTb');
      tt.innerHTML = (p.topFiles || []).map(function (r) {
        return '<tr><td>' + esc(r.path) + '</td><td>' + String(r.count) + '</td></tr>';
      }).join('');
      if (!p.topFiles || p.topFiles.length === 0) {
        tt.innerHTML = '<tr><td colspan="2" class="muted">Нет данных</td></tr>';
      }
      var bars = document.getElementById('bars');
      var dc = p.dailyCounts || [];
      var maxc = 0;
      for (var i = 0; i < dc.length; i++) {
        if (dc[i].count > maxc) maxc = dc[i].count;
      }
      bars.innerHTML = dc.map(function (d) {
        var barH = maxc > 0 ? Math.max(4, Math.round((d.count / maxc) * 100)) : (d.count > 0 ? 8 : 2);
        var dd = d.date.slice(5);
        return '<div class="barwrap"><div class="bar" style="height:' + String(barH) + 'px" title="' +
          esc(d.date + ': ' + String(d.count)) + '"></div><span class="bardate">' + esc(dd) + '</span></div>';
      }).join('');
    }
    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function renderHeatmap(m) {
      var grid = document.getElementById('heatGrid');
      if (!grid) return;
      var peak = 0;
      for (var d = 0; d < 7; d++) {
        for (var h = 0; h < 24; h++) {
          if (m[d][h] > peak) peak = m[d][h];
        }
      }
      var dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var html = '';
      // Header row: hour labels (every 4 hours)
      html += '<div class="heatRow">';
      html += '<div class="heatLabel"></div>';
      for (var hh = 0; hh < 24; hh++) {
        html += '<div class="heatHour">' + (hh % 4 === 0 ? String(hh) : '') + '</div>';
      }
      html += '</div>';
      for (var dd = 0; dd < 7; dd++) {
        html += '<div class="heatRow"><div class="heatLabel">' + dows[dd] + '</div>';
        for (var hr = 0; hr < 24; hr++) {
          var v = m[dd][hr];
          var op = peak > 0 ? Math.max(0.05, v / peak) : 0;
          html += '<div class="heatCell" title="' + dows[dd] + ' ' + String(hr) + ':00 — ' + String(v) +
            '" style="background: rgba(73,194,143,' + op.toFixed(2) + ')"></div>';
        }
        html += '</div>';
      }
      grid.innerHTML = html;
    }
    window.addEventListener('message', function (ev) {
      if (ev.data && ev.data.type === 'stats' && ev.data.payload) {
        render(ev.data.payload);
        if (ev.data.heatmap) {
          renderHeatmap(ev.data.heatmap);
        }
      }
    });
    document.getElementById('btnRefresh').addEventListener('click', function () {
      vscode.postMessage({ type: 'refresh' });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

let panel: vscode.WebviewPanel | undefined;
let lastStatsStorageDir: string | undefined;

function cfgSection(): string {
  return "vscodesync";
}

async function pushPayload(wv: vscode.WebviewPanel["webview"], storageDir: string): Promise<void> {
  const [activity, stats] = await Promise.all([loadActivityFile(storageDir), loadStatsFile(storageDir)]);
  const conf = vscode.workspace.getConfiguration(cfgSection());
  const monthlyLimitMB = conf.get<number>("monthlyBandwidthLimitMB", 0);
  const compressUploads = conf.get<boolean>("compressUploads", false);
  const payload: StatsDashboardPayload = buildStatsDashboardPayload(activity.events, stats, {
    monthlyLimitMB: Math.max(0, monthlyLimitMB),
    compressUploads,
  });
  const heatmap = bucketActivity(activity.events);
  await wv.postMessage({ type: "stats", payload, heatmap });
}

export function openStatsDashboardPanel(context: vscode.ExtensionContext, storageDir: string): void {
  lastStatsStorageDir = storageDir;

  if (!panel) {
    panel = vscode.window.createWebviewPanel(WEBVIEW_VIEW_TYPE, "VSCodeSync · Stats", vscode.ViewColumn.One, {
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
      async (msg: { type?: string }) => {
        const dir = lastStatsStorageDir;
        const wv = panel?.webview;
        if (!dir || !wv) {
          return;
        }
        if (msg.type === "ready" || msg.type === "refresh") {
          await pushPayload(wv, dir);
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
  void pushPayload(wv, storageDir);
}
