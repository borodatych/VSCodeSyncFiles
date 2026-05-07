/**
 * Emoji-free formatter for notification strings.
 *
 * Some corporate chat / mail integrations re-encode emoji unpredictably and
 * VS Code accessibility tooling reads them as raw codepoints. When
 * `vscodesync.notifications.emojiFree` is `true`, we strip / replace emoji
 * with text markers ([ok], [warn], [err], [info]).
 */
import * as vscode from "vscode";

const REPLACEMENTS: readonly [RegExp, string][] = [
  [/✅|✔️|✔/g, "[ok]"],
  [/⚠️|⚠/g, "[warn]"],
  [/❌|✖|✗/g, "[err]"],
  [/ℹ️|ℹ|💡/g, "[info]"],
  [/🔴/g, "[red]"],
  [/🟡/g, "[yellow]"],
  [/🟢/g, "[green]"],
  [/📡/g, "[net]"],
  [/🔒/g, "[lock]"],
  [/🔓/g, "[unlock]"],
  [/⏸|⏯/g, "[pause]"],
  [/▶|▶️/g, "[play]"],
  [/📦/g, "[pkg]"],
  [/📁|📂/g, "[dir]"],
  [/🚀/g, "[boost]"],
  [/✏️|✏/g, "[edit]"],
  [/⏱|⏰|⏳/g, "[time]"],
  [/⚡/g, "[zap]"],
  [/🔄/g, "[sync]"],
  // Catch-all for any remaining emoji (broad surrogate-pair range).
  [/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}]/gu, ""],
];

export function isEmojiFreeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("vscodesync")
    .get<boolean>("notifications.emojiFree", false);
}

export function formatNotification(text: string): string {
  if (!isEmojiFreeEnabled()) return text;
  let out = text;
  for (const [re, sub] of REPLACEMENTS) {
    out = out.replace(re, sub);
  }
  return out.replace(/\s+/g, " ").trim();
}
