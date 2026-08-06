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
    /** PKCE + loopback: browser returns the code by itself (E13). */
    oneDrivePkce: () => Promise<void>;
    googleDrivePkce: () => Promise<void>;
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

    /**
     * One palette entry for signing in (F12). Nine separate commands —
     * four providers × browser/headless plus device code — filled the palette
     * with variants the user has to know the difference between before they can
     * choose. The per-provider commands stay registered (Command Center,
     * keybindings, `executeCommand`), just hidden from the palette.
     */
    vscode.commands.registerCommand("vscodesync.signIn", async () => {
      type Pick = vscode.QuickPickItem & { run: () => Promise<void> };
      const items: Pick[] = [
        // Browser-first, because that is the flow with nothing to type: the
        // redirect comes back to 127.0.0.1 on its own. Device Code stays for
        // hosts without a usable browser — SSH, containers, a remote machine.
        { label: "$(cloud) OneDrive", description: "браузер", run: () => signIn.oneDrivePkce() },
        { label: "$(cloud) Google Drive", description: "браузер", run: () => signIn.googleDrivePkce() },
        { label: "$(cloud) Dropbox", description: "браузер", run: () => signIn.dropbox(true) },
        { label: "$(cloud) Яндекс Диск", description: "браузер", run: () => signIn.yandexDisk(true) },
        {
          label: "$(key) OneDrive — код устройства",
          description: "если браузер недоступен или вход не проходит",
          run: () => signIn.oneDrive(true),
        },
        {
          label: "$(key) Google Drive — код устройства",
          description: "если браузер недоступен или вход не проходит",
          run: () => signIn.googleDrive(true),
        },
        {
          label: "$(terminal) OneDrive — код устройства без браузера",
          description: "URL в панели Output",
          run: () => signIn.oneDrive(false),
        },
        {
          label: "$(terminal) Google Drive — код устройства без браузера",
          description: "URL в панели Output",
          run: () => signIn.googleDrive(false),
        },
        {
          label: "$(terminal) Dropbox — без браузера",
          description: "URL в панели Output",
          run: () => signIn.dropbox(false),
        },
        {
          label: "$(terminal) Яндекс Диск — без браузера",
          description: "URL в панели Output",
          run: () => signIn.yandexDisk(false),
        },
        {
          label: "$(key) Device Code",
          description: "вход с другого устройства",
          run: async () => {
            await vscode.commands.executeCommand("vscodesync.signInDeviceCode");
          },
        },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: "VSCodeSync: вход в облако",
        placeHolder: "Выберите провайдера",
      });
      await picked?.run();
    }),

    vscode.commands.registerCommand("vscodesync.onedriveSignInBrowser", async () => {
      await signIn.oneDrivePkce();
    }),
    vscode.commands.registerCommand("vscodesync.googleDriveSignInBrowser", async () => {
      await signIn.googleDrivePkce();
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
      void vscode.window.showInformationMessage("Яндекс Диск: токен сохранён.");
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
    }),
  ];
}
