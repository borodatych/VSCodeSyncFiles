import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderType } from "../core/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import {
  copyVsCodeSyncFilesToPreMigrationSnapshot,
  copyVsCodeSyncTreeBetweenProviders,
  deleteVsCodeSyncRootOnProvider,
  listExportableVsCodeSyncFiles,
  patchManifestProviderTypesOnProvider,
  preMigrationSnapshotFolderBasename,
} from "../core/cloudMigration.js";
import { rejectIfSecondaryWorkspaceInstanceReadOnly } from "../core/syncWorkspaceInstanceReadOnly.js";
import type { WorkspacesTreeProvider } from "./workspacesTree.js";
import { labelForProviderType } from "./activeProviderSwitch.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";

const ALL: ProviderType[] = ["onedrive", "gdrive", "yandex", "dropbox"];

async function ensureAuthenticated(
  registry: ProviderRegistry,
  type: ProviderType,
  signInOneDrive: () => Promise<void>,
  signInGoogleDrive: () => Promise<void>,
  signInDropbox: () => Promise<void>,
  signInYandexDisk: () => Promise<void>,
): Promise<ICloudProvider | null> {
  if (!(await registry.isAuthenticatedFor(type))) {
    if (type === "onedrive") {
      await signInOneDrive();
    } else if (type === "gdrive") {
      await signInGoogleDrive();
    } else if (type === "dropbox") {
      await signInDropbox();
    } else {
      await signInYandexDisk();
    }
  }
  if (!(await registry.isAuthenticatedFor(type))) {
    return null;
  }
  return registry.getFor(type);
}

export interface ProviderMigrationDeps {
  registry: ProviderRegistry;
  globalConfig: GlobalConfigManager;
  workspacesTree: WorkspacesTreeProvider;
  makeEngine: (root: string, provider: ICloudProvider, machineId: string, machineName: string, trigger: SyncTrigger) => SyncEngine;
  signInOneDrive: () => Promise<void>;
  signInGoogleDrive: () => Promise<void>;
  signInDropbox: () => Promise<void>;
  signInYandexDisk: () => Promise<void>;
  refreshUi: () => Promise<void>;
}

export function registerProviderMigrationCommand(context: vscode.ExtensionContext, deps: ProviderMigrationDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.migrateToAnotherProvider", async () => {
      try {
        rejectIfSecondaryWorkspaceInstanceReadOnly();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showWarningMessage(msg);
        return;
      }

      const cfg = await deps.globalConfig.load();
      const sourceType = cfg.activeProvider;
      if (!sourceType) {
        await vscode.window.showWarningMessage("VSCodeSync: не выбран активный провайдер.");
        return;
      }

      const targets = ALL.filter((t) => t !== sourceType);
      const picked = await vscode.window.showQuickPick(
        targets.map((t) => ({
          label: labelForProviderType(t),
          type: t,
        })),
        {
          placeHolder: `Миграция с ${labelForProviderType(sourceType)} на другой провайдер (облачная копия + переключение)`,
        },
      );
      if (!picked) {
        return;
      }

      const targetType = picked.type;
      const ok = await vscode.window.showWarningMessage(
        `Будет создан снапшот pre-migration на текущем облаке, затем все файлы VSCodeSyncFiles скопируются на «${labelForProviderType(targetType)}». Локальные проекты обновятся под новый провайдер. После успеха можно удалить копию на старом облаке (отдельный шаг). Продолжить?`,
        { modal: true },
        "Начать миграцию",
        "Отмена",
      );
      if (ok !== "Начать миграцию") {
        return;
      }

      const sourceProv = await ensureAuthenticated(
        deps.registry,
        sourceType,
        deps.signInOneDrive,
        deps.signInGoogleDrive,
        deps.signInDropbox,
        deps.signInYandexDisk,
      );
      if (!sourceProv) {
        await vscode.window.showErrorMessage("VSCodeSync: исходный провайдер недоступен.");
        return;
      }

      const targetProv = await ensureAuthenticated(
        deps.registry,
        targetType,
        deps.signInOneDrive,
        deps.signInGoogleDrive,
        deps.signInDropbox,
        deps.signInYandexDisk,
      );
      if (!targetProv) {
        return;
      }

      const exportable = await listExportableVsCodeSyncFiles(sourceProv);
      if (exportable.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: на исходном облаке нет файлов VSCodeSyncFiles для переноса.");
        return;
      }

      const snapName = preMigrationSnapshotFolderBasename();

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "VSCodeSync: миграция провайдера",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0, message: `Снапшот на старом провайдере: ${snapName}…` });
          await copyVsCodeSyncFilesToPreMigrationSnapshot(sourceProv, snapName, (done, total) => {
            progress.report({
              increment: 0,
              message: `Бэкап: ${String(done)}/${String(total)}`,
            });
          });

          progress.report({ increment: 30, message: "Копирование на новый провайдер…" });
          await copyVsCodeSyncTreeBetweenProviders(sourceProv, targetProv, (done, total) => {
            progress.report({
              increment: 0,
              message: `Копия: ${String(done)}/${String(total)}`,
            });
          });

          progress.report({ increment: 30, message: "Обновление providerType в манифестах…" });
          await patchManifestProviderTypesOnProvider(targetProv, targetType);

          await deps.globalConfig.set("activeProvider", targetType);
          await deps.globalConfig.save();
          deps.workspacesTree.setActiveCloudProvider(targetType);

          const gc = await deps.globalConfig.load();
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const engine = deps.makeEngine(folder.uri.fsPath, targetProv, gc.machineId, gc.machineName, "user");
            await engine.repairLocalStateFromCloud();
          }

          progress.report({ increment: 40, message: "Готово" });
        },
      );

      await deps.refreshUi();

      const delOld = await vscode.window.showWarningMessage(
        `VSCodeSync: миграция на ${labelForProviderType(targetType)} завершена. Удалить папку VSCodeSyncFiles на старом провайдере (${labelForProviderType(sourceType)})? Это удалит и бэкап VSCodeSyncFiles/.snapshots/${snapName}/ на старом облаке. Убедитесь, что копия на новом провайдере в порядке.`,
        { modal: true },
        "Удалить на старом облаке",
        "Оставить",
      );

      if (delOld === "Удалить на старом облаке") {
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `VSCodeSync: удаление на ${labelForProviderType(sourceType)}`,
              cancellable: false,
            },
            async () => {
              await deleteVsCodeSyncRootOnProvider(sourceProv);
            },
          );
          await deps.refreshUi();
          void vscode.window.showInformationMessage(
            `VSCodeSync: данные на ${labelForProviderType(sourceType)} удалены. Рабочая копия — на ${labelForProviderType(targetType)}.`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await vscode.window.showErrorMessage(
            `VSCodeSync: не удалось полностью удалить данные на старом провайдере (${labelForProviderType(sourceType)}): ${msg}`,
          );
        }
      } else {
        void vscode.window.showInformationMessage(
          `VSCodeSync: старый провайдер не очищался. На исходном облаке — бэкап: VSCodeSyncFiles/.snapshots/${snapName}/`,
        );
      }
    }),
  );
}
