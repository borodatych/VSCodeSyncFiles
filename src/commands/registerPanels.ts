/**
 * Pure command-registration shim — first step of the `extension.ts`
 * decomposition (v2.6 in the roadmap). Today this only covers two
 * webview-opener commands; the goal is to demonstrate the wiring shape so
 * subsequent decomposition PRs can move 60+ inline `registerCommand` blocks
 * into per-area files (`commands/workspaces.ts`, `commands/files.ts`, …)
 * without touching `activate(...)` itself.
 *
 * Contract:
 *   - All deps come in via `PanelCommandsDeps` — no module-level state.
 *   - Each `register…` returns a Disposable; the caller pushes it into
 *     `context.subscriptions`.
 *   - No `vscode.window.show…` / `runWithEngine` here — keeps the bundle
 *     of commands thin.
 */
import * as vscode from "vscode";
import { openMachineGraphPanel } from "../ui/machineGraphPanel.js";
import { openQuickTransferDropPanel } from "../ui/quickTransferDropPanel.js";
import { openSankeyChartPanel } from "../ui/sankeyChartPanel.js";

export interface PanelCommandsDeps {
  context: vscode.ExtensionContext;
  storageDir: string;
}

export function registerPanelCommands(deps: PanelCommandsDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vscodesync.openMachinesGraph", () => {
      openMachineGraphPanel(deps.context, deps.storageDir);
    }),
    vscode.commands.registerCommand("vscodesync.openQuickTransferDrop", () => {
      openQuickTransferDropPanel(deps.context);
    }),
    vscode.commands.registerCommand("vscodesync.openSankeyChart", () => {
      openSankeyChartPanel(deps.context, deps.storageDir);
    }),
  ];
}
