/**
 * v3.N — Sync Replay Viewer webview panel.
 *
 * Thin wrapper over `renderSyncReplayViewerHtml`. Lists `replay-*.json`
 * files in the storage dir, lets the user pick one, parses it via
 * `parseReplaySession`, converts recorder events to the playback shape
 * the renderer expects, and opens a webview with the rendered timeline.
 *
 * No interactive cursor controls — the renderer accepts an optional
 * `cursor` and dims future events; we render with cursor at end (full
 * timeline) for the MVP. Adding play/pause/seek is a future iteration.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWebviewNonce } from "../utils/webviewNonce.js";
import { renderSyncReplayViewerHtml } from "../core/syncReplayViewerHtml.js";
import { parseReplaySession } from "../core/syncReplayRecorder.js";
import type { ReplayEvent as PlaybackEvent } from "../core/syncReplayPlayback.js";

const WEBVIEW_VIEW_TYPE = "vscodesync.syncReplayViewer";
const FILE_PREFIX = "replay-";

interface ReplayFileItem extends vscode.QuickPickItem {
  fsPath: string;
}

async function listReplayFiles(storageDir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(storageDir);
    return names
      .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(".json"))
      .map((n) => path.join(storageDir, n));
  } catch {
    return [];
  }
}

export async function runOpenSyncReplayViewer(
  context: vscode.ExtensionContext,
  storageDir: string,
): Promise<void> {
  const files = await listReplayFiles(storageDir);
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      "VSCodeSync: нет сохранённых записей. Запустите «Start Sync Recording», воспроизведите кейс, остановите запись.",
    );
    return;
  }
  const items: ReplayFileItem[] = await Promise.all(
    files.map(async (fp) => {
      const stat = await fs.stat(fp).catch(() => undefined);
      const sizeKb = stat ? Math.round(stat.size / 1024) : 0;
      return {
        fsPath: fp,
        label: `$(history) ${path.basename(fp)}`,
        description: stat ? `${String(sizeKb)} KB` : undefined,
        detail: stat ? `Изменён ${stat.mtime.toLocaleString()}` : undefined,
      };
    }),
  );
  items.sort((a, b) => (a.detail ?? "") < (b.detail ?? "") ? 1 : -1);
  const picked = await vscode.window.showQuickPick(items, {
    title: "VSCodeSync · Sync Replay Viewer",
    placeHolder: "Выберите запись для просмотра",
  });
  if (!picked) return;

  let raw: unknown;
  try {
    const text = await fs.readFile(picked.fsPath, "utf8");
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(`VSCodeSync: не удалось прочитать запись — ${msg}`);
    return;
  }
  const session = parseReplaySession(raw);
  if (!session) {
    await vscode.window.showErrorMessage(
      "VSCodeSync: запись повреждена (несовместимая schema). Попробуйте более свежую запись.",
    );
    return;
  }

  const events: PlaybackEvent[] = session.events.map((e) => ({
    tsMs: Date.parse(e.at),
    kind: e.kind,
    relPath: e.relPath || undefined,
    machineName: session.machineName,
    detail: e.meta,
  }));

  const panel = vscode.window.createWebviewPanel(
    WEBVIEW_VIEW_TYPE,
    `VSCodeSync · Replay (${path.basename(picked.fsPath)})`,
    vscode.ViewColumn.One,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.onDidDispose(() => { /* nothing to clean up */ }, null, context.subscriptions);

  const nonce = getWebviewNonce();
  const csp = panel.webview.cspSource;
  const body = renderSyncReplayViewerHtml(events, {
    title: `Replay: ${session.sessionId.slice(0, 8)}…`,
    cursor: { next: events.length, total: events.length, atEnd: true },
  });
  panel.webview.html = `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>VSCodeSync Replay</title>
  </head>
  <body>
${body}
  </body>
</html>`;
}
