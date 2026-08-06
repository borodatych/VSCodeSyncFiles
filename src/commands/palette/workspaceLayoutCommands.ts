/**
 * Workspace layout — palette commands.
 *
 * Раскладка воркспейса: соответствие путей между машинами, локальные ignore-правила, объединение воркспейсов.
 *
 * Вынесено из `ui/plannedPaletteCommands.ts` (F12): 27 команд из семи доменов
 * жили в одном файле на 1115 строк, и добавление любой новой команды делало
 * его ещё менее читаемым.
 */
import * as vscode from "vscode";
import { runConfigurePathMapping } from "../../ui/configurePathMapping.js";
import { runEditWorkspaceIgnorePatterns } from "../../ui/workspaceIgnorePatternsUi.js";
import { runMergeWorkspaces } from "../../ui/mergeWorkspacesWizard.js";
import type { PaletteExtras } from "./_shared.js";

export function registerWorkspaceLayoutCommands(
  context: vscode.ExtensionContext,
  extras: PaletteExtras,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.configurePathMapping", async () => {
      await runConfigurePathMapping(extras.globalConfig);
    }),

    vscode.commands.registerCommand("vscodesync.editWorkspaceIgnorePatterns", async () => {
      await runEditWorkspaceIgnorePatterns({
        globalConfig: extras.globalConfig,
        tryAuthenticatedProvider: extras.tryAuthenticatedProvider,
        makeEngine: extras.makeEngine,
      });
    }),

    vscode.commands.registerCommand("vscodesync.mergeWorkspaces", async () => {
      await runMergeWorkspaces({
        globalConfig: extras.globalConfig,
        tryAuthenticatedProvider: extras.tryAuthenticatedProvider,
        makeEngine: extras.makeEngine,
        refreshAfterLocalConfigChange: extras.refreshAfterLocalConfigChange,
      });
    }),
  );
}
