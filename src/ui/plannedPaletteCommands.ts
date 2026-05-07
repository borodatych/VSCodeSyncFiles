import * as vscode from "vscode";
import { GlobalConfigManager } from "../core/globalConfigManager.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import {
  exportWorkspaceStructure,
  exportWorkspaceStructureFullCache,
  importWorkspaceStructure,
} from "./workspaceStructureBackup.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";
import {
  createWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
} from "../core/snapshotsEngine.js";
import { exportKeyWithPassword, importKeyWithPassword, generateEncryptionKey, encryptBuffer, decryptBuffer } from "../core/encryption.js";
import { readEncryptionKey, storeEncryptionKey } from "../core/encryptionKey.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { WorkspacesTreeProvider } from "./workspacesTree.js";
import { runConfigurePathMapping } from "./configurePathMapping.js";
import { runEditWorkspaceIgnorePatterns } from "./workspaceIgnorePatternsUi.js";
import { runMergeWorkspaces } from "./mergeWorkspacesWizard.js";
import { openActivityFeedPanel } from "./activityFeedPanel.js";
import { openStatsDashboardPanel } from "./statsDashboardPanel.js";
import { resolveWorkspaceRootForPaletteCommand } from "../utils/workspaceRootResolver.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";

const CFG = "vscodesync";


/** Расширение для `registerPlannedPaletteCommands`: глобальный конфиг + обновление UI после локальных изменений. */
export interface PlannedPaletteExtras {
  globalConfig: GlobalConfigManager;
  /** Build engine (shared ignore, snapshots, …). */
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
  ) => SyncEngine;
  refreshAfterLocalConfigChange?: () => void | Promise<void>;
  /** After global session pause ends: preview plan + optional full sync. */
  runAfterSessionResume?: () => void | Promise<void>;
  /** For snapshot commands — authenticated provider. */
  tryAuthenticatedProvider?: () => Promise<ICloudProvider | null>;
  workspacesTree?: WorkspacesTreeProvider;
  /** For encryption key commands — VSCode SecretStorage. */
  secrets?: import("vscode").SecretStorage;
}

/** Команды из docs/v1/03-ui/roadmap.md §3.3 без полной реализации — palette + заглушка или минимальный UX. */
export function registerPlannedPaletteCommands(
  context: vscode.ExtensionContext,
  extras: PlannedPaletteExtras,
): void {
  const configuration = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(CFG);

  const refreshGlobal = async (): Promise<void> => {
    await extras.refreshAfterLocalConfigChange?.();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.togglePause", async () => {
      const next = !syncSessionPause.isPaused();
      syncSessionPause.setPaused(next);
      if (!next) {
        await extras.runAfterSessionResume?.();
      }
      await refreshGlobal();
      if (next) {
        await vscode.window.showInformationMessage(
          "VSCodeSync: пауза (только эта сессия). Автосинхронизация отключена; ручные Push/Pull и Quick Transfer доступны.",
        );
      }
    }),
    vscode.commands.registerCommand("vscodesync.resume", async () => {
      if (!syncSessionPause.isPaused()) {
        await refreshGlobal();
        return;
      }
      syncSessionPause.setPaused(false);
      await extras.runAfterSessionResume?.();
      await refreshGlobal();
      await vscode.window.showInformationMessage("VSCodeSync: Resume — пауза снята.");
    }),
    vscode.commands.registerCommand("vscodesync.enableWatchMode", async () => {
      await configuration().update("watchMode", true, vscode.ConfigurationTarget.Global);
      await vscode.window.showInformationMessage(
        "VSCodeSync: watchMode включён — фоновый полный sync по интервалу (см. watchIntervalSeconds); на глобальной паузе опрос останавливается.",
      );
    }),
    vscode.commands.registerCommand("vscodesync.createSnapshot", async () => {
      if (!(await assertWorkspaceTrusted())) {
        return;
      }
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
        return;
      }
      const gc = await extras.globalConfig.load();
      const { WorkspaceConfigManager: WCM } = await import("../core/workspaceConfigManager.js");
      const wc = await WCM.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }

      let workspaceId: string | undefined;
      if (wc.activeWorkspaces.length === 1) {
        workspaceId = wc.activeWorkspaces[0]?.workspaceId;
      } else {
        const picked = await vscode.window.showQuickPick(
          wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, id: w.workspaceId })),
          { placeHolder: "Workspace для снапшота" },
        );
        workspaceId = picked?.id;
      }
      if (!workspaceId) {
        return;
      }

      const nameInput = await vscode.window.showInputBox({
        prompt: "Имя снапшота (например: перед деплоем)",
        placeHolder: "snapshot-name",
      });
      if (!nameInput?.trim()) {
        return;
      }

      const wsId = workspaceId;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: создание снапшота…", cancellable: false },
        async () => {
          const finalName = await createWorkspaceSnapshot(provider, root, wsId, nameInput, gc.machineName);
          await vscode.window.showInformationMessage(`VSCodeSync: снапшот «${finalName}» создан.`);
        },
      );
    }),

    vscode.commands.registerCommand("vscodesync.restoreSnapshot", async () => {
      if (!(await assertWorkspaceTrusted())) {
        return;
      }
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
        return;
      }
      const gc = await extras.globalConfig.load();
      const { WorkspaceConfigManager: WCM } = await import("../core/workspaceConfigManager.js");
      const wc = await WCM.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }

      let workspaceId: string | undefined;
      if (wc.activeWorkspaces.length === 1) {
        workspaceId = wc.activeWorkspaces[0]?.workspaceId;
      } else {
        const picked = await vscode.window.showQuickPick(
          wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, id: w.workspaceId })),
          { placeHolder: "Workspace для восстановления" },
        );
        workspaceId = picked?.id;
      }
      if (!workspaceId) {
        return;
      }

      const snapshots = await listWorkspaceSnapshots(provider, workspaceId);
      if (snapshots.length === 0) {
        await vscode.window.showInformationMessage("VSCodeSync: снапшотов не найдено.");
        return;
      }

      const items = snapshots.map((s) => ({
        label: s.meta.name,
        description: `${s.category === "system" ? "🔒 Системный" : "Пользовательский"} · ${new Date(s.meta.createdAt).toLocaleString(vscode.env.language)} · ${String(s.meta.files.length)} файлов`,
        name: s.name,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Выберите снапшот для восстановления",
      });
      if (!picked) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Восстановить снапшот «${picked.label}»? Перед восстановлением будет создан авто-снапшот. Текущие локальные файлы будут перезаписаны.`,
        { modal: true },
        "Восстановить",
      );
      if (confirm !== "Восстановить") {
        return;
      }

      const wsIdRestore = workspaceId;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: восстановление снапшота…", cancellable: false },
        async (progress) => {
          progress.report({ message: "Создание авто-снапшота…" });
          await createWorkspaceSnapshot(
            provider,
            root,
            wsIdRestore,
            `auto-pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`,
            gc.machineName,
          );
          progress.report({ message: "Восстановление файлов…" });
          const result = await restoreWorkspaceSnapshot(provider, root, wsIdRestore, picked.name, gc.machineName);
          await vscode.window.showInformationMessage(
            `VSCodeSync: восстановлено ${String(result.restoredCount)} файлов из снапшота «${picked.label}».`,
          );
        },
      );
    }),
    vscode.commands.registerCommand("vscodesync.disableWatchMode", async () => {
      await configuration().update("watchMode", false, vscode.ConfigurationTarget.Global);
      await vscode.window.showInformationMessage("VSCodeSync: watchMode выключен.");
    }),
    vscode.commands.registerCommand("vscodesync.toggleWatchMode", async () => {
      const cfg = configuration();
      const next = !cfg.get<boolean>("watchMode", false);
      await cfg.update("watchMode", next, vscode.ConfigurationTarget.Global);
      await vscode.window.showInformationMessage(`VSCodeSync: watchMode — ${next ? "вкл" : "выкл"}.`);
    }),
    vscode.commands.registerCommand("vscodesync.openStats", () => {
      openStatsDashboardPanel(context, extras.globalConfig.getStorageDir());
    }),
    vscode.commands.registerCommand("vscodesync.openActivityFeed", async () => {
      const gc = await extras.globalConfig.load();
      openActivityFeedPanel(context, extras.globalConfig.getStorageDir(), gc.machineName);
    }),
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

    vscode.commands.registerCommand("vscodesync.exportEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const key = await readEncryptionKey(secrets);
      if (!key) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: ключ шифрования не найден. Включите vscodesync.encryption и перезапустите VSCode.",
        );
        return;
      }
      const password = await vscode.window.showInputBox({
        prompt: "Пароль для защиты файла ключа (не меньше 8 символов)",
        password: true,
        validateInput: (v) => (v.length >= 8 ? null : "Минимум 8 символов"),
      });
      if (!password) {
        return;
      }
      const blob = await exportKeyWithPassword(key, password);
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(".vscodesync-key.enc"),
        filters: { "VSCodeSync Key": ["enc"] },
      });
      if (!uri) {
        return;
      }
      const { writeFile, mkdir } = await import("node:fs/promises");
      const nodePath = await import("node:path");
      await mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await writeFile(uri.fsPath, blob);
      await vscode.window.showInformationMessage(
        "VSCodeSync: ключ экспортирован. Сохраните файл в безопасном месте — без него расшифровать данные невозможно.",
      );
    }),

    vscode.commands.registerCommand("vscodesync.importEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const openResult = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "VSCodeSync Key": ["enc"] },
      });
      const fileUri = openResult?.[0];
      if (!fileUri) {
        return;
      }
      const password = await vscode.window.showInputBox({
        prompt: "Пароль от файла ключа",
        password: true,
      });
      if (password === undefined) {
        return;
      }
      try {
        const { readFile } = await import("node:fs/promises");
        const blob = await readFile(fileUri.fsPath);
        const key = await importKeyWithPassword(blob, password);
        await storeEncryptionKey(secrets, key);
        await vscode.window.showInformationMessage("VSCodeSync: ключ шифрования импортирован и сохранён.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`VSCodeSync: ошибка импорта ключа — ${msg}`);
      }
    }),

    vscode.commands.registerCommand("vscodesync.rotateEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const encryptionOn = vscode.workspace.getConfiguration(CFG).get<boolean>("encryption", false);
      if (!encryptionOn) {
        await vscode.window.showWarningMessage("VSCodeSync: шифрование не включено (vscodesync.encryption: false).");
        return;
      }
      const oldKey = await readEncryptionKey(secrets);
      if (!oldKey) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: старый ключ не найден. Включите vscodesync.encryption и перезапустите VSCode.",
        );
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        "VSCodeSync: Ротация ключа шифрования. Перед началом будут созданы авто-снапшоты всех workspace. Все облачные файлы будут перезашифрованы. Продолжить?",
        { modal: true },
        "Начать ротацию",
      );
      if (confirm !== "Начать ротацию") {
        return;
      }
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
        return;
      }
      const gc = await extras.globalConfig.load();

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: ротация ключа…", cancellable: false },
        async (progress) => {
          // Step 1: Auto-snapshots for all workspaces
          const folders = vscode.workspace.workspaceFolders ?? [];
          const snapshotDate = new Date().toISOString().replace(/[:.]/g, "-");
          let totalFiles = 0;
          for (const folder of folders) {
            const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
            for (const ws of wc.activeWorkspaces) {
              progress.report({ message: `Снапшот workspace ${ws.workspaceNote || ws.workspaceId}…` });
              const engine = extras.makeEngine(folder.uri.fsPath, provider, gc.machineId, gc.machineName);
              try {
                await createWorkspaceSnapshot(provider, folder.uri.fsPath, ws.workspaceId, `auto-pre-key-rotation-${snapshotDate}`, gc.machineName);
              } catch {
                // Non-fatal: continue with rotation even if snapshot fails
              }
              totalFiles += wc.files.filter((f) => f.workspaceId === ws.workspaceId).length;
              void engine; // engine used for snapshot
            }
          }

          // Step 2: Generate new key
          const newKey = generateEncryptionKey();
          progress.report({ message: "Перешифровка файлов…" });

          // Step 3: Re-encrypt all tracked files
          let processed = 0;
          for (const folder of folders) {
            const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
            for (const file of wc.files) {
              if (!file.cloudPath) {
                continue;
              }
              progress.report({ message: `${String(processed + 1)}/${String(totalFiles)}: ${file.localPath}` });
              try {
                const dl = await provider.downloadFile(file.cloudPath);
                const plaintext = decryptBuffer(oldKey, dl.body);
                const newCiphertext = encryptBuffer(newKey, plaintext);
                await provider.uploadFile(file.cloudPath, newCiphertext, { ifMatch: dl.etag });
              } catch {
                // If file doesn't exist or fails, skip
              }
              processed++;
            }
          }

          // Step 4: Store new key
          await storeEncryptionKey(secrets, newKey);

          await extras.refreshAfterLocalConfigChange?.();
          await vscode.window.showInformationMessage(
            `VSCodeSync: ротация ключа завершена. Перешифровано ${String(processed)} файлов. Рекомендуется экспортировать новый ключ (VSCodeSync: Export Encryption Key).`,
            "Экспортировать",
          ).then(async (choice) => {
            if (choice === "Экспортировать") {
              await vscode.commands.executeCommand("vscodesync.exportEncryptionKey");
            }
          });
        },
      );
    }),
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
