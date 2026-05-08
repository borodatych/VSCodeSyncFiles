/**
 * v3.G — pure HTML renderer for the visual 3-way merger webview.
 *
 * Renders a 3-pane (base | local | cloud) layout with per-hunk choice
 * buttons. Each conflict hunk gets [Mine] [Theirs] [Merged] radio-style
 * controls; clean / addition / deletion hunks get a single auto-decided
 * label (no buttons).
 *
 * Pure — no `vscode` import. The webview controller passes `MergeHunk[]`
 * (from `visualMergePlan.ts`) and a current `choices` map; this function
 * returns the body HTML. The controller wires up postMessage callbacks for
 * the radio inputs.
 */
import { escapeHtml, joinClasses } from "./htmlEscape.js";
import type { HunkChoice, MergeHunk } from "./visualMergePlan.js";

export interface VisualMergerRenderOptions {
  /** Caller's current per-hunk choice map. Defaults to "mine" for conflicts. */
  choices?: Partial<Record<number, HunkChoice>>;
  /** Optional title bar. */
  title?: string;
}

export function renderVisualMergerHtml(
  hunks: readonly MergeHunk[],
  options: VisualMergerRenderOptions = {},
): string {
  const choices = options.choices ?? {};
  const title = escapeHtml(options.title ?? "Visual 3-way merge");

  const blocks = hunks.map((h) => renderHunk(h, choices[h.index])).join("\n");
  const conflictCount = hunks.filter((h) => h.kind === "conflict").length;

  return `${STYLE}
<div class="vss-merger">
  <header class="vss-merger-header">
    <h2>${title}</h2>
    <span class="vss-merger-meta">${String(hunks.length)} hunks · ${String(conflictCount)} conflicts</span>
  </header>
  <div class="vss-merger-grid">
    <div class="vss-merger-col-head">Base</div>
    <div class="vss-merger-col-head">Local (mine)</div>
    <div class="vss-merger-col-head">Cloud (theirs)</div>
    ${blocks}
  </div>
</div>`;
}

function renderHunk(hunk: MergeHunk, choice: HunkChoice | undefined): string {
  const kindClass = `vss-hunk-${hunk.kind.replace(/_/g, "-")}`;
  const baseLines = renderLines(hunk.base);
  const localLines = renderLines(hunk.local);
  const cloudLines = renderLines(hunk.cloud);
  const controls =
    hunk.kind === "conflict"
      ? renderConflictControls(hunk.index, choice ?? "mine")
      : `<span class="vss-hunk-auto">${escapeHtml(describeAutoKind(hunk.kind))}</span>`;
  return `<div class="vss-hunk ${joinClasses(kindClass)}" data-hunk-index="${String(hunk.index)}">
  <pre class="vss-hunk-pane vss-hunk-base">${baseLines}</pre>
  <pre class="vss-hunk-pane vss-hunk-local">${localLines}</pre>
  <pre class="vss-hunk-pane vss-hunk-cloud">${cloudLines}</pre>
  <div class="vss-hunk-controls">${controls}</div>
</div>`;
}

function renderLines(lines: readonly string[]): string {
  if (lines.length === 0) return "<em>(empty)</em>";
  return lines.map((l) => escapeHtml(l)).join("\n");
}

function renderConflictControls(index: number, current: HunkChoice): string {
  const opt = (value: HunkChoice, label: string): string => {
    const isChecked = current === value ? " checked" : "";
    return `<label>
      <input type="radio" name="vss-hunk-${String(index)}" value="${escapeHtml(value)}"${isChecked} />
      ${escapeHtml(label)}
    </label>`;
  };
  return `${opt("mine", "Mine")}${opt("theirs", "Theirs")}${opt("merged", "Merged")}`;
}

function describeAutoKind(kind: MergeHunk["kind"]): string {
  switch (kind) {
    case "clean":
      return "= unchanged";
    case "addition_local":
      return "+ added locally";
    case "addition_cloud":
      return "+ added on cloud";
    case "deletion_local":
      return "− deleted locally";
    case "deletion_cloud":
      return "− deleted on cloud";
    case "conflict":
      return "conflict";
  }
}

const STYLE = `<style>
  .vss-merger {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  .vss-merger-header {
    display: flex;
    align-items: baseline;
    gap: 1em;
    padding: 0.5em 1em;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .vss-merger-header h2 { margin: 0; font-size: 1.2em; }
  .vss-merger-meta { color: var(--vscode-descriptionForeground); }
  .vss-merger-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    column-gap: 0.5em;
    row-gap: 1em;
    padding: 1em;
  }
  .vss-merger-col-head {
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    padding-bottom: 0.25em;
  }
  .vss-hunk {
    display: contents;
  }
  .vss-hunk-pane {
    margin: 0;
    padding: 0.5em;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 2px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  .vss-hunk.vss-hunk-conflict .vss-hunk-pane {
    border-color: var(--vscode-errorForeground);
  }
  .vss-hunk.vss-hunk-clean .vss-hunk-pane {
    opacity: 0.7;
  }
  .vss-hunk-controls {
    grid-column: 1 / span 3;
    display: flex;
    gap: 1em;
    padding: 0.25em 0.5em;
    border-bottom: 1px dashed var(--vscode-panel-border);
  }
  .vss-hunk-controls label {
    cursor: pointer;
  }
  .vss-hunk-auto {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
</style>`;
