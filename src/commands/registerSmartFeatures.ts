/**
 * Smart-features command bundle — second tranche of the `extension.ts`
 * decomposition (v2.6 in the roadmap). Holds palette commands that depend
 * only on `ExtensionContext` and the global storage dir — no `runWithEngine`,
 * no provider, no module-level state.
 *
 * Same contract as `registerPanels.ts`:
 *   - All deps come in via `SmartFeaturesCommandsDeps`.
 *   - Each `register…` returns a Disposable list; caller pushes into
 *     `context.subscriptions`.
 *   - Lazy-import heavy implementations so `activate(...)` stays cold.
 */
import * as vscode from "vscode";
import { runShowAchievements } from "../ui/achievementsService.js";

export interface SmartFeaturesCommandsDeps {
  context: vscode.ExtensionContext;
  storageDir: string;
}

export function registerSmartFeaturesCommands(deps: SmartFeaturesCommandsDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vscodesync.showAchievements", async () => {
      await runShowAchievements(deps.context, deps.storageDir);
    }),
    vscode.commands.registerCommand("vscodesync.installWorkspaceTemplate", async () => {
      const { runInstallWorkspaceTemplate } = await import("../ui/workspaceTemplatesCommand.js");
      await runInstallWorkspaceTemplate();
    }),
    vscode.commands.registerCommand("vscodesync.openSyncReplayViewer", async () => {
      const { runOpenSyncReplayViewer } = await import("../ui/syncReplayViewerPanel.js");
      await runOpenSyncReplayViewer(deps.context, deps.storageDir);
    }),
  ];
}
