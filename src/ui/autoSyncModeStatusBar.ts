import * as vscode from "vscode";
import { parseAutoSyncMode, describeAutoSyncMode } from "../core/autoSyncMode.js";

const CFG = "vscodesync";

/**
 * Tiny status-bar item dedicated to `autoSyncMode`. Sits to the left of the
 * main provider widget; click = quick-pick that calls `cycleAutoSyncMode`.
 * Visual: $(eye-closed) | $(eye) | $(sync) depending on mode.
 *
 * Why a second item: the main `syncStatus` item already has a click handler
 * (focus workspaces view). One-click mode-switching is a frequent ask, so we
 * give it its own real estate instead of overloading the existing widget.
 */
export function registerAutoSyncModeStatusBar(
  context: vscode.ExtensionContext,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    "vscodesync.autoSyncModeStatus",
    vscode.StatusBarAlignment.Left,
    101,
  );
  item.command = "vscodesync.cycleAutoSyncMode";

  const refresh = (): void => {
    const mode = parseAutoSyncMode(
      vscode.workspace.getConfiguration(CFG).get<string>("autoSyncMode", "check-only"),
    );
    const icon = mode === "off" ? "$(eye-closed)" : "$(eye)";
    const label = mode === "off" ? "off" : "check";
    item.text = `${icon} ${label}`;
    item.tooltip = `${describeAutoSyncMode(mode)}\n\nКлик: сменить режим.`;
    item.show();
  };

  refresh();

  context.subscriptions.push(
    item,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CFG}.autoSyncMode`)) {
        refresh();
      }
    }),
  );

  return item;
}
