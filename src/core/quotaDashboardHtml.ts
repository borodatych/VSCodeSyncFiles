/**
 * v3.B — pure HTML renderer for `vscodesync.showQuotaDashboard` webview.
 *
 * Takes a `QuotaSnapshot[]` (same shape `quotaTracker.snapshotAll()` returns)
 * and produces a self-contained HTML body string that uses VS Code's
 * built-in CSS variables for theming. No external libs, no charts — a CSS
 * grid of horizontal bars, one per provider.
 *
 * Caller wraps in a `<html>` shell and writes to `webview.html`. Pure module
 * — no `vscode` import.
 */
import { escapeHtml, joinClasses } from "./htmlEscape.js";
import type { QuotaSnapshot } from "./quotaTracker.js";

export interface QuotaDashboardOptions {
  /** Override the empty-state message. */
  emptyMessage?: string;
}

const SEVERITY_LABEL: Record<QuotaSnapshot["severity"], string> = {
  ok: "OK",
  warning: "Warning",
  critical: "Critical",
  auto_pause: "Auto-paused",
};

export function renderQuotaDashboardHtml(
  snapshots: readonly QuotaSnapshot[],
  options: QuotaDashboardOptions = {},
): string {
  if (snapshots.length === 0) {
    const msg = escapeHtml(options.emptyMessage ?? "No API calls recorded yet.");
    return `<div class="vss-quota-empty">${msg}</div>`;
  }

  const rows = snapshots
    .map((s) => renderRow(s))
    .join("\n");

  return `${STYLE}
<div class="vss-quota-grid">
  <div class="vss-quota-header">
    <span>Provider</span>
    <span>Usage</span>
    <span>Severity</span>
  </div>
  ${rows}
</div>`;
}

function renderRow(s: QuotaSnapshot): string {
  const widthPct = (Math.min(s.ratio, 1) * 100).toFixed(1);
  const limitText =
    s.dailyLimit === null ? "no known limit" : `${String(s.callsInWindow)} / ${String(s.dailyLimit)}`;
  const severityClass = `vss-sev-${s.severity}`;
  return `<div class="vss-quota-row ${joinClasses(severityClass)}">
  <span class="vss-quota-provider">${escapeHtml(s.provider)}</span>
  <span class="vss-quota-bar-wrap" title="${escapeHtml(limitText)}">
    <span class="vss-quota-bar" style="width:${widthPct}%"></span>
    <span class="vss-quota-bar-label">${escapeHtml(limitText)}</span>
  </span>
  <span class="vss-quota-sev ${joinClasses(severityClass)}">${escapeHtml(SEVERITY_LABEL[s.severity])}</span>
</div>`;
}

const STYLE = `<style>
  .vss-quota-empty {
    padding: 1.5em;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family);
  }
  .vss-quota-grid {
    display: grid;
    grid-template-columns: 8em 1fr 8em;
    gap: 0.5em 1em;
    padding: 1em;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    font-size: var(--vscode-font-size);
  }
  .vss-quota-header {
    display: contents;
    font-weight: bold;
    color: var(--vscode-descriptionForeground);
  }
  .vss-quota-row {
    display: contents;
  }
  .vss-quota-bar-wrap {
    position: relative;
    background: var(--vscode-input-background);
    height: 1.5em;
    border-radius: 2px;
    overflow: hidden;
  }
  .vss-quota-bar {
    display: block;
    height: 100%;
    background: var(--vscode-progressBar-background);
    transition: width 0.2s ease;
  }
  .vss-quota-bar-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    color: var(--vscode-foreground);
    font-size: 0.85em;
    text-shadow: 0 0 2px var(--vscode-editor-background);
  }
  .vss-quota-row.vss-sev-warning .vss-quota-bar { background: var(--vscode-editorWarning-foreground); }
  .vss-quota-row.vss-sev-critical .vss-quota-bar { background: var(--vscode-editorError-foreground); }
  .vss-quota-row.vss-sev-auto_pause .vss-quota-bar { background: var(--vscode-errorForeground); }
  .vss-quota-sev {
    align-self: center;
    font-weight: 500;
  }
  .vss-quota-sev.vss-sev-warning { color: var(--vscode-editorWarning-foreground); }
  .vss-quota-sev.vss-sev-critical { color: var(--vscode-editorError-foreground); }
  .vss-quota-sev.vss-sev-auto_pause { color: var(--vscode-errorForeground); }
</style>`;
