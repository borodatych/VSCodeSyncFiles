/**
 * Time Travel scrubber webview — slider over `.history/{relPath}/`.
 *
 * On open: the host lists the history folder, parses filenames into
 * HistoryVersion records via `parseHistoryFilename`, builds the tick model
 * via `buildTimeTravelModel`, and posts it to the webview. The webview
 * renders a slider; on change it postMessage's the tick index back, the
 * host downloads the corresponding blob and ships its UTF-8 text to the
 * webview for display.
 */
import * as vscode from "vscode";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { historyDirForFile } from "../core/cloudLayout.js";
import {
  buildTimeTravelModel,
  parseHistoryFilename,
  type HistoryVersion,
  type TimeTravelModel,
} from "../core/timeTravelScrubber.js";
import { getWebviewNonce } from "../utils/webviewNonce.js";

const WEBVIEW_VIEW_TYPE = "vscodesyncTimeTravel";

export interface TimeTravelDeps {
  context: vscode.ExtensionContext;
  provider: ICloudProvider;
  workspaceId: string;
  relPath: string;
}

export async function openTimeTravelScrubber(deps: TimeTravelDeps): Promise<void> {
  const dir = historyDirForFile(deps.workspaceId, deps.relPath);
  let listed: { cloudPath: string; size?: number }[];
  try {
    listed = await deps.provider.listFolder(dir);
  } catch {
    listed = [];
  }
  const versions: HistoryVersion[] = [];
  for (const item of listed) {
    const v = parseHistoryFilename(item.cloudPath, item.size ?? 0);
    if (v) versions.push(v);
  }
  if (versions.length === 0) {
    void vscode.window.showInformationMessage(
      `VSCodeSync: для «${deps.relPath}» в облаке нет .history записей.`,
    );
    return;
  }
  const model = buildTimeTravelModel(versions);

  const panel = vscode.window.createWebviewPanel(
    WEBVIEW_VIEW_TYPE,
    `VSCodeSync · Time Travel · ${deps.relPath}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  deps.context.subscriptions.push(panel);

  const wv = panel.webview;
  wv.html = buildHtml(getWebviewNonce(), wv.cspSource, deps.relPath);

  // Track the latest sent index so a slow download doesn't stomp a fresh
  // request. Each request carries `seq`; we only post the response if the
  // local seq still matches.
  let seq = 0;
  const downloadVersion = async (idx: number, mySeq: number): Promise<void> => {
    if (idx < 0 || idx >= model.ticks.length) return;
    const tick = model.ticks[idx];
    let text: string;
    try {
      const dl = await deps.provider.downloadFile(tick.version.cloudPath);
      text = dl.body.toString("utf8");
    } catch (e) {
      text = `// VSCodeSync: download failed — ${e instanceof Error ? e.message : String(e)}`;
    }
    if (mySeq !== seq) return;
    await wv.postMessage({
      type: "version",
      index: idx,
      total: model.ticks.length,
      machineName: tick.version.machineName,
      createdAtIso: new Date(tick.version.createdAtMs).toISOString(),
      text,
    });
  };

  panel.webview.onDidReceiveMessage(
    async (msg: { type?: string; index?: number }) => {
      if (msg.type === "ready") {
        await wv.postMessage({ type: "model", model: redactForWire(model) });
        seq++;
        const last = model.ticks.length - 1;
        await downloadVersion(last, seq);
      } else if (msg.type === "scrub" && typeof msg.index === "number") {
        seq++;
        await downloadVersion(msg.index, seq);
      }
    },
    undefined,
    deps.context.subscriptions,
  );
}

/** Strip cloudPath fields that the webview doesn't need to know. */
function redactForWire(m: TimeTravelModel): {
  ticks: { index: number; positionFraction: number; createdAtIso: string; machineName: string }[];
  earliestIso: string;
  latestIso: string;
} {
  return {
    ticks: m.ticks.map((t) => ({
      index: t.index,
      positionFraction: t.positionFraction,
      createdAtIso: new Date(t.version.createdAtMs).toISOString(),
      machineName: t.version.machineName,
    })),
    earliestIso: new Date(m.earliestMs).toISOString(),
    latestIso: new Date(m.latestMs).toISOString(),
  };
}

function buildHtml(nonce: string, csp: string, relPath: string): string {
  const safeRel = relPath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}'" />
  <title>VSCodeSync · Time Travel</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; margin: 0; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 6px 0; word-break: break-all; }
    p.muted { opacity: 0.75; font-size: 0.9em; margin: 4px 0 12px 0; }
    .scrubber { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    input[type="range"] { flex: 1; }
    .meta { font-size: 0.85em; opacity: 0.85; margin-bottom: 8px; }
    pre.viewer {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-foreground));
      padding: 8px; max-height: 70vh; overflow: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      white-space: pre; tab-size: 2;
    }
  </style>
</head>
<body>
  <h1>Time Travel · ${safeRel}</h1>
  <p class="muted">Слайдер ходит по версиям файла из облачной .history папки. Текст обновляется по мере скачивания.</p>
  <div class="scrubber">
    <span id="rangeStart">…</span>
    <input id="slider" type="range" min="0" max="0" step="1" value="0" />
    <span id="rangeEnd">…</span>
  </div>
  <div class="meta" id="meta">…</div>
  <pre class="viewer" id="viewer">Загрузка…</pre>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const slider = document.getElementById('slider');
    const meta = document.getElementById('meta');
    const viewer = document.getElementById('viewer');
    const rangeStart = document.getElementById('rangeStart');
    const rangeEnd = document.getElementById('rangeEnd');
    let total = 0;
    function fmtIso(s) { return s.replace('T', ' ').replace('.000Z', 'Z'); }
    window.addEventListener('message', function(ev) {
      const m = ev.data || {};
      if (m.type === 'model' && m.model) {
        total = m.model.ticks.length;
        slider.max = String(Math.max(total - 1, 0));
        slider.value = String(Math.max(total - 1, 0));
        rangeStart.textContent = fmtIso(m.model.earliestIso);
        rangeEnd.textContent = fmtIso(m.model.latestIso);
        meta.textContent = total + ' version(s)';
      } else if (m.type === 'version') {
        const tick = m;
        meta.textContent = '#' + (tick.index + 1) + ' / ' + tick.total + ' · ' + fmtIso(tick.createdAtIso) + ' · ' + tick.machineName;
        viewer.textContent = tick.text;
      }
    });
    slider.addEventListener('input', function() {
      const idx = Number(slider.value);
      vscode.postMessage({ type: 'scrub', index: idx });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
