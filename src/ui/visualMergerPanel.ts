/**
 * Visual 3-way merger — the webview controller over the pure pieces that had
 * no caller: `buildMergePlan` (base/local/cloud → hunks),
 * `renderVisualMergerHtml` (3-pane markup with per-hunk radios) and
 * `applyHunkChoices` (picks → merged lines).
 *
 * Conflicts were resolvable only as whole-file "keep mine" / "take theirs";
 * this is the per-hunk answer. Nothing is written until the user presses
 * «Применить»: the panel is a proposal, not an action.
 *
 * Base comes from the newest cloud history snapshot. Without one there is no
 * three-way merge to do — the panel says so and points at the whole-file
 * commands instead of silently pretending local is the base.
 */
import * as vscode from "vscode";
import { buildMergePlan, applyHunkChoices, type HunkChoice } from "../core/visualMergePlan.js";
import { renderVisualMergerHtml } from "../core/visualMergerHtml.js";

const VIEW_TYPE = "vscodesync.visualMerger";

export interface VisualMergerSource {
  /** Line arrays; the planner is line-based. */
  base: string[];
  local: string[];
  cloud: string[];
  /** Shown in the panel title. */
  label: string;
  /** Where «Применить» writes the merged result. */
  targetUri: vscode.Uri;
}

let panel: vscode.WebviewPanel | undefined;

export function openVisualMergerPanel(
  context: vscode.ExtensionContext,
  source: VisualMergerSource,
  onApplied?: () => void | Promise<void>,
): void {
  const plan = buildMergePlan(source.base, source.local, source.cloud);
  const choices: Partial<Record<number, HunkChoice>> = {};

  if (panel) {
    panel.dispose();
    panel = undefined;
  }
  panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `VSCodeSync · Слияние — ${source.label}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const current = panel;
  current.webview.html = pageHtml(plan.hunks, choices, source.label, plan.conflictCount);

  current.webview.onDidReceiveMessage(
    (msg: unknown) => {
      const m = msg as { type?: string; index?: number; choice?: string };
      if (m.type === "choice" && typeof m.index === "number" && isChoice(m.choice)) {
        choices[m.index] = m.choice;
        return;
      }
      if (m.type !== "apply") return;
      void (async () => {
        const merged = applyHunkChoices(plan.hunks, choices);
        const text = merged.join("\n");
        await vscode.workspace.fs.writeFile(source.targetUri, Buffer.from(text, "utf8"));
        current.dispose();
        void vscode.window.showInformationMessage(
          `VSCodeSync: слияние применено к «${source.label}». ` +
            "Файл изменён локально — отправьте его, когда результат устроит.",
        );
        await onApplied?.();
      })();
    },
    undefined,
    context.subscriptions,
  );

  current.onDidDispose(
    () => {
      panel = undefined;
    },
    null,
    context.subscriptions,
  );
}

function isChoice(v: unknown): v is HunkChoice {
  return v === "mine" || v === "theirs" || v === "merged";
}

function pageHtml(
  hunks: ReturnType<typeof buildMergePlan>["hunks"],
  choices: Partial<Record<number, HunkChoice>>,
  label: string,
  conflictCount: number,
): string {
  const body = renderVisualMergerHtml(hunks, {
    choices,
    title: `Слияние: ${label}`,
  });
  // The renderer emits plain radios named `vss-hunk-<index>`; the script here
  // is the only moving part — it reports picks and asks for the write.
  return `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>VSCodeSync · Слияние</title></head>
<body style="font-family: var(--vscode-font-family); padding: 12px;">
${body}
<p style="opacity:.85; margin-top:16px">
  Конфликтных участков: ${String(conflictCount)}. Для каждого выберите свою версию,
  чужую или «Merged». Остальные участки сливаются автоматически.
  Ничего не записывается, пока вы не нажмёте «Применить».
</p>
<button id="vss-apply" style="padding:6px 14px; font-size:13px">Применить слияние</button>
<script>
  const vscode = acquireVsCodeApi();
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.type !== 'radio') return;
    const m = /^vss-hunk-(\\d+)$/.exec(t.name || '');
    if (!m) return;
    vscode.postMessage({ type: 'choice', index: Number(m[1]), choice: t.value });
  });
  document.getElementById('vss-apply').addEventListener('click', () => {
    vscode.postMessage({ type: 'apply' });
  });
</script>
</body>
</html>`;
}
