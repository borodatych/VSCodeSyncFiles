/**
 * v3.N — pure HTML renderer for the sync-replay viewer webview.
 *
 * Renders a vertical timeline: each event becomes a row with a colored
 * marker (per kind), an ISO-time stamp, the optional file/machine, and
 * the event detail. Events past the cursor's `next` index render dimmed.
 *
 * Pure — no `vscode` import. Caller drives navigation via
 * `syncReplayPlayback.ts` (cursor + filter helpers) and re-renders this
 * HTML on each step.
 */
import { escapeHtml, joinClasses } from "./htmlEscape.js";
import type { ReplayCursor, ReplayEvent } from "./syncReplayPlayback.js";

export interface SyncReplayViewerOptions {
  cursor?: ReplayCursor;
  /** Optional title bar. */
  title?: string;
  /** Override per-kind colors. */
  colorByKind?: Record<string, string>;
}

const DEFAULT_COLOR_BY_KIND: Record<string, string> = {
  push: "var(--vscode-charts-green)",
  pull: "var(--vscode-charts-blue)",
  conflict: "var(--vscode-editorError-foreground)",
  add: "var(--vscode-charts-yellow)",
  remove: "var(--vscode-charts-orange)",
  resolve_keep_mine: "var(--vscode-charts-purple)",
  resolve_take_theirs: "var(--vscode-charts-purple)",
};

export function renderSyncReplayViewerHtml(
  events: readonly ReplayEvent[],
  options: SyncReplayViewerOptions = {},
): string {
  const title = escapeHtml(options.title ?? "Sync replay");
  const cursor = options.cursor;
  const colorMap = { ...DEFAULT_COLOR_BY_KIND, ...(options.colorByKind ?? {}) };

  const cursorPos = cursor ? `${String(cursor.next)} / ${String(cursor.total)}` : "live";

  if (events.length === 0) {
    return `${STYLE}
<div class="vss-replay">
  <header class="vss-replay-header">
    <h2>${title}</h2>
    <span class="vss-replay-meta">cursor: ${escapeHtml(cursorPos)}</span>
  </header>
  <div class="vss-replay-empty">No events to replay.</div>
</div>`;
  }

  const rows = events
    .map((e, i) => renderRow(e, i, cursor, colorMap))
    .join("\n");

  return `${STYLE}
<div class="vss-replay">
  <header class="vss-replay-header">
    <h2>${title}</h2>
    <span class="vss-replay-meta">cursor: ${escapeHtml(cursorPos)}</span>
  </header>
  <ol class="vss-replay-timeline">
    ${rows}
  </ol>
</div>`;
}

function renderRow(
  event: ReplayEvent,
  index: number,
  cursor: ReplayCursor | undefined,
  colorMap: Record<string, string>,
): string {
  const isFuture = cursor !== undefined && index >= cursor.next;
  const ts = new Date(event.tsMs).toISOString();
  const color = colorMap[event.kind] ?? "var(--vscode-charts-foreground)";
  const meta: string[] = [];
  if (event.machineName) meta.push(escapeHtml(event.machineName));
  if (event.relPath) meta.push(escapeHtml(event.relPath));
  return `<li class="${joinClasses("vss-replay-row", isFuture && "vss-replay-future")}">
  <span class="vss-replay-marker" style="background:${color}"></span>
  <time class="vss-replay-time" datetime="${escapeHtml(ts)}">${escapeHtml(ts)}</time>
  <span class="vss-replay-kind">${escapeHtml(event.kind)}</span>
  <span class="vss-replay-context">${meta.join(" · ")}</span>
</li>`;
}

const STYLE = `<style>
  .vss-replay {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
  }
  .vss-replay-empty {
    padding: 1.5em;
    color: var(--vscode-descriptionForeground);
  }
  .vss-replay-header {
    display: flex;
    align-items: baseline;
    gap: 1em;
    padding: 0.5em 1em;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .vss-replay-header h2 { margin: 0; font-size: 1.1em; }
  .vss-replay-meta { color: var(--vscode-descriptionForeground); }
  .vss-replay-timeline {
    list-style: none;
    padding: 1em;
    margin: 0;
  }
  .vss-replay-row {
    display: grid;
    grid-template-columns: 0.75em 14em 8em 1fr;
    gap: 0.5em;
    align-items: center;
    padding: 0.25em 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .vss-replay-row.vss-replay-future {
    opacity: 0.45;
  }
  .vss-replay-marker {
    width: 0.6em;
    height: 0.6em;
    border-radius: 50%;
    display: inline-block;
  }
  .vss-replay-time {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }
  .vss-replay-kind {
    font-weight: 500;
  }
  .vss-replay-context {
    color: var(--vscode-descriptionForeground);
  }
</style>`;
