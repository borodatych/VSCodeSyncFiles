/**
 * Quota dashboard — how much of each provider's daily API budget this window
 * has spent. The renderer (`renderQuotaDashboardHtml`) and the counter
 * (`quotaTracker` + `wrapWithQuotaTracking`) both existed with no caller; this
 * is the surface that makes them reachable.
 *
 * Singleton panel, same as the other dashboards: a second `createWebviewPanel`
 * orphans the first one's disposables.
 */
import * as vscode from "vscode";
import { renderQuotaDashboardHtml } from "../core/quotaDashboardHtml.js";
import { sharedQuotaTracker } from "../core/quotaTrackerSingleton.js";

const VIEW_TYPE = "vscodesync.quotaDashboard";

let panel: vscode.WebviewPanel | undefined;

export function openQuotaDashboardPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    panel.webview.html = pageHtml();
    return;
  }
  panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "VSCodeSync · Квота провайдера",
    vscode.ViewColumn.One,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = pageHtml();
  panel.onDidDispose(
    () => {
      panel = undefined;
    },
    null,
    context.subscriptions,
  );
}

function pageHtml(): string {
  const snapshots = sharedQuotaTracker().snapshotAll();
  const body = renderQuotaDashboardHtml(snapshots, {
    emptyMessage:
      "Обращений к облаку в этом окне ещё не было — счётчик наполняется по мере работы.",
  });
  // The counter is per-window and per-session on purpose: it answers "am I
  // about to hit the limit right now", not "what did I spend this month".
  return `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>VSCodeSync · Квота</title></head>
<body style="font-family: var(--vscode-font-family); padding: 12px;">
<h2 style="margin-top:0">Обращения к API провайдера</h2>
<p style="opacity:.8">
  Счёт ведётся за скользящие сутки и только для этого окна VS Code.
  Лимиты — публичные суточные квоты провайдеров; там, где провайдер их не
  публикует, показывается только число вызовов.
</p>
${body}
</body>
</html>`;
}
