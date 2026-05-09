/**
 * Provider sign-in / switch command bundle — third tranche of the
 * `extension.ts` decomposition (v2.6 in the roadmap).
 *
 * Holds the 10 commands that select a cloud provider or run its OAuth /
 * Device Code flow. The 4 `signIn.<provider>` callbacks stay as closures
 * in `activate(...)` — they capture per-provider OutputChannel and
 * `context.secrets` — and are passed in via deps. That keeps this module
 * free of provider-specific OAuth code.
 *
 * Same contract as `registerPanels.ts` / `registerSmartFeatures.ts`:
 *   - All deps come in via `ProviderSignInCommandsDeps`.
 *   - Each `register…` returns a Disposable list; caller pushes into
 *     `context.subscriptions`.
 */
import * as vscode from "vscode";
import { runActiveProviderSwitch } from "../ui/activeProviderSwitch.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { ProviderRegistry } from "../providers/registry.js";

export interface ProviderSignInCommandsDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
  fileDecorations: SyncFileDecorationController;
  registry: ProviderRegistry;
  refreshActiveEditor: () => void;
  refreshCloudWebhooks: () => void;
  signIn: {
    oneDrive: (openBrowser: boolean) => Promise<void>;
    googleDrive: (openBrowser: boolean) => Promise<void>;
    dropbox: (openBrowser: boolean) => Promise<void>;
    yandexDisk: (openBrowser: boolean) => Promise<void>;
  };
}

export function registerProviderSignInCommands(
  deps: ProviderSignInCommandsDeps,
): vscode.Disposable[] {
  const {
    context,
    globalConfig,
    workspacesTree,
    statusBar,
    fileDecorations,
    registry,
    refreshActiveEditor,
    refreshCloudWebhooks,
    signIn,
  } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.setActiveProvider", async () => {
      await runActiveProviderSwitch({
        registry,
        globalConfig,
        workspacesTree,
        signInOneDrive: () => signIn.oneDrive(true),
        signInGoogleDrive: () => signIn.googleDrive(true),
        signInDropbox: () => signIn.dropbox(true),
        signInYandexDisk: () => signIn.yandexDisk(true),
        refreshStatusAndPanels: async () => {
          await statusBar.refresh();
          workspacesTree.refresh();
          fileDecorations.refresh();
          refreshActiveEditor();
          refreshCloudWebhooks();
        },
      });
    }),

    vscode.commands.registerCommand("vscodesync.onedriveSignIn", async () => {
      await signIn.oneDrive(true);
    }),
    vscode.commands.registerCommand("vscodesync.onedriveSignInHeadless", async () => {
      await signIn.oneDrive(false);
    }),

    vscode.commands.registerCommand("vscodesync.googleDriveSignIn", async () => {
      await signIn.googleDrive(true);
    }),
    vscode.commands.registerCommand("vscodesync.googleDriveSignInHeadless", async () => {
      await signIn.googleDrive(false);
    }),

    vscode.commands.registerCommand("vscodesync.dropboxSignIn", async () => {
      await signIn.dropbox(true);
    }),
    vscode.commands.registerCommand("vscodesync.dropboxSignInHeadless", async () => {
      await signIn.dropbox(false);
    }),

    vscode.commands.registerCommand("vscodesync.yandexDiskSignIn", async () => {
      await signIn.yandexDisk(true);
    }),
    vscode.commands.registerCommand("vscodesync.yandexDiskSignInHeadless", async () => {
      await signIn.yandexDisk(false);
    }),

    vscode.commands.registerCommand("vscodesync.yandexDiskEnterToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "VSCodeSync: Яндекс Диск — ввод токена вручную",
        prompt:
          "Вставьте OAuth-токен (AQA…). Получить: oauth.yandex.ru → ваше приложение → «Получить OAuth-токен»",
        password: true,
        placeHolder: "AQAAAABxxxxxxxx…",
        validateInput: (v) => (v.trim().length < 10 ? "Слишком короткий токен" : undefined),
      });
      if (!token?.trim()) return;
      const { storeYandexTokens } = await import("../providers/yandex/yandexTokens.js");
      await storeYandexTokens(context.secrets, {
        accessToken: token.trim(),
        expiresAtMs: Date.now() + 365 * 24 * 3600 * 1000, // отладочный токен не истекает
      });
      await globalConfig.set("activeProvider", "yandex");
      await globalConfig.save();
      workspacesTree.setActiveCloudProvider("yandex");
      await vscode.window.showInformationMessage("Яндекс Диск: токен сохранён.");
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
    }),
  ];
}
