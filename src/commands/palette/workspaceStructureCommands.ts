/**
 * Workspace structure export / import — palette commands.
 *
 * Перенос состава воркспейса: выгрузка структуры, загрузка структуры, выгрузка файлов в папку, восстановление из облака.
 *
 * Вынесено из `ui/plannedPaletteCommands.ts` (F12): 27 команд из семи доменов
 * жили в одном файле на 1115 строк, и добавление любой новой команды делало
 * его ещё менее читаемым.
 */
import * as vscode from "vscode";
import {
  exportWorkspaceStructure,
  exportWorkspaceStructureFullCache,
  importWorkspaceStructure,
} from "../../ui/workspaceStructureBackup.js";
import { resolveWorkspaceRootForPaletteCommand } from "../../utils/workspaceRootResolver.js";
import type { PaletteExtras } from "./_shared.js";
import { runCloudExportFlow } from "./_shared.js";

export function registerWorkspaceStructureCommands(
  context: vscode.ExtensionContext,
  extras: PaletteExtras,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.exportWorkspaceStructure", async () => {
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      type Epick = vscode.QuickPickItem & { mode: "portable" | "full" };
      const pick = await vscode.window.showQuickPick<Epick>(
        [
          {
            label: "Портативная структура (для коллег)",
            description: "schema 2: workspace id, пути; без хэшей и токенов",
            mode: "portable",
          },
          {
            label: "Полный локальный кэш",
            description: "schema 1: activeWorkspaces + files как в vscodesync.json",
            mode: "full",
          },
        ],
        { placeHolder: "Тип экспорта структуры workspace" },
      );
      if (!pick) {
        return;
      }
      if (pick.mode === "full") {
        await exportWorkspaceStructureFullCache(root);
        return;
      }
      const gc = await extras.globalConfig.load();
      await exportWorkspaceStructure(root, gc.machineName);
    }),
    vscode.commands.registerCommand("vscodesync.importWorkspaceStructure", async () => {
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      try {
        await importWorkspaceStructure(root, {
          globalConfig: extras.globalConfig,
          makeEngine: extras.makeEngine,
          tryAuthenticatedProvider: extras.tryAuthenticatedProvider ?? (() => Promise.resolve(null)),
        });
        await extras.refreshAfterLocalConfigChange?.();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`VSCodeSync Import: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("vscodesync.exportWorkspaceToFolder", async () => {
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
        return;
      }
      const target = await runCloudExportFlow(provider, "Целевая папка для экспорта");
      if (target) {
        void vscode.window.showInformationMessage(`VSCodeSync: экспортировано в ${target}.`);
      }
    }),
    vscode.commands.registerCommand("vscodesync.restoreFromCloud", async () => {
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
        return;
      }
      const target = await runCloudExportFlow(provider, "Папка для восстановления (откроется как workspace)");
      if (!target) return;
      await vscode.window
        .showInformationMessage(
          `VSCodeSync: восстановление в ${target}. Открыть как workspace?`,
          "Открыть",
          "Не сейчас",
        )
        .then((choice) => {
          if (choice === "Открыть") {
            void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), true);
          }
        });
    }),
  );
}
