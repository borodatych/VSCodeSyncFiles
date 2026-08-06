/**
 * Provider OAuth flow factory — packages the 4 sign-in closures
 * (OneDrive Device Code, Google Drive Device Code, Dropbox PKCE
 * Loopback, Yandex OAuth Loopback) plus their OutputChannels into a
 * single `createProviderAuthFlows(deps)` factory.
 *
 * Lifted out of extension.ts as part of v2.6.7 (extension.ts < 500 LoC
 * goal). The factory creates per-provider OutputChannels, registers
 * them into `context.subscriptions`, and returns the 4 sign-in
 * closures with the same `(openBrowser: boolean) => Promise<void>`
 * shape that registerProviderSignInCommands expects.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { runOneDriveDeviceCodeLogin } from "../providers/onedrive/onedriveDeviceCode.js";
import {
  ONEDRIVE_PKCE_REDIRECT_URI,
  runOneDrivePkceOAuth,
} from "../providers/onedrive/onedrivePkceOAuth.js";
import {
  GDRIVE_PKCE_REDIRECT_URI,
  runGdrivePkceOAuth,
} from "../providers/gdrive/gdrivePkceOAuth.js";
import { runGoogleDriveDeviceCodeLogin } from "../providers/gdrive/gdriveDeviceCode.js";
import { DROPBOX_OAUTH_REDIRECT_URI, runDropboxOAuthLoopback } from "../providers/dropbox/dropboxPkceOAuth.js";
import { YANDEX_OAUTH_REDIRECT_URI, runYandexOAuthLoopback } from "../providers/yandex/yandexPkceOAuth.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";

const CFG_SECTION = "vscodesync";

export interface ProviderAuthFlowsDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
  fileDecorations: SyncFileDecorationController;
  refreshActiveEditor: () => void;
  refreshCloudWebhooks: () => void;
}

export interface ProviderAuthFlows {
  oneDrive: (openBrowser: boolean) => Promise<void>;
  googleDrive: (openBrowser: boolean) => Promise<void>;
  /**
   * PKCE + loopback for OneDrive / Google Drive (E13).
   *
   * The browser returns the code to `127.0.0.1` on its own — nothing to type.
   * Device Code stays available for hosts without a usable browser (SSH,
   * containers, a remote machine): it is a different flow, not a worse one.
   */
  oneDrivePkce: () => Promise<void>;
  googleDrivePkce: () => Promise<void>;
  dropbox: (openBrowser: boolean) => Promise<void>;
  yandexDisk: (openBrowser: boolean) => Promise<void>;
}

export function createProviderAuthFlows(deps: ProviderAuthFlowsDeps): ProviderAuthFlows {
  const {
    context,
    globalConfig,
    workspacesTree,
    statusBar,
    fileDecorations,
    refreshActiveEditor,
    refreshCloudWebhooks,
  } = deps;

  const oneDriveOutputChannel = vscode.window.createOutputChannel("VSCodeSync · OneDrive");
  context.subscriptions.push(oneDriveOutputChannel);
  const googleDriveOutputChannel = vscode.window.createOutputChannel("VSCodeSync · Google Drive");
  context.subscriptions.push(googleDriveOutputChannel);
  const dropboxOutputChannel = vscode.window.createOutputChannel("VSCodeSync · Dropbox");
  context.subscriptions.push(dropboxOutputChannel);
  const yandexOutputChannel = vscode.window.createOutputChannel("VSCodeSync · Yandex Disk");
  context.subscriptions.push(yandexOutputChannel);

  const refreshAll = async (): Promise<void> => {
    await statusBar.refresh();
    workspacesTree.refresh();
    fileDecorations.refresh();
    refreshActiveEditor();
  };

  const oneDrive = async (openBrowser: boolean): Promise<void> => {
    const clientId = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("onedriveClientId", "");
    if (!clientId) {
      await vscode.window.showErrorMessage("Задайте vscodesync.onedriveClientId в настройках.");
      return;
    }
    oneDriveOutputChannel.clear();
    oneDriveOutputChannel.show(true);
    try {
      await runOneDriveDeviceCodeLogin(context.secrets, clientId, (uri, userCode, msg) => {
        oneDriveOutputChannel.appendLine(msg);
        oneDriveOutputChannel.appendLine("");
        oneDriveOutputChannel.appendLine("Verification URL:");
        oneDriveOutputChannel.appendLine(uri);
        oneDriveOutputChannel.appendLine("");
        oneDriveOutputChannel.appendLine(`User code: ${userCode}`);
        if (openBrowser) {
          void vscode.window.showInformationMessage(msg);
          void vscode.env.openExternal(vscode.Uri.parse(uri));
        } else {
          void vscode.window.showInformationMessage(
            "OneDrive Device Code: откройте URL из панели Output (VSCodeSync · OneDrive), например в браузере на другой машине, и введите код.",
          );
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      oneDriveOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(`OneDrive: ${msg}`);
      return;
    }
    await globalConfig.set("activeProvider", "onedrive");
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider("onedrive");
    refreshCloudWebhooks();
    void vscode.window.showInformationMessage("OneDrive: токены сохранены.");
    await refreshAll();
  };

  const googleDrive = async (openBrowser: boolean): Promise<void> => {
    const clientId = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("googleDriveClientId", "");
    if (!clientId) {
      await vscode.window.showErrorMessage("Задайте vscodesync.googleDriveClientId в настройках.");
      return;
    }
    googleDriveOutputChannel.clear();
    googleDriveOutputChannel.show(true);
    try {
      await runGoogleDriveDeviceCodeLogin(context.secrets, clientId, (uri, userCode, msg) => {
        googleDriveOutputChannel.appendLine(msg);
        googleDriveOutputChannel.appendLine("");
        googleDriveOutputChannel.appendLine("Verification URL:");
        googleDriveOutputChannel.appendLine(uri);
        googleDriveOutputChannel.appendLine("");
        googleDriveOutputChannel.appendLine(`User code: ${userCode}`);
        if (openBrowser) {
          void vscode.window.showInformationMessage(msg);
          void vscode.env.openExternal(vscode.Uri.parse(uri));
        } else {
          void vscode.window.showInformationMessage(
            "Google Drive Device Code: откройте URL из панели Output (VSCodeSync · Google Drive), например в браузере на другой машине, и введите код.",
          );
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      googleDriveOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(`Google Drive: ${msg}`);
      return;
    }
    await globalConfig.set("activeProvider", "gdrive");
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider("gdrive");
    void vscode.window.showInformationMessage("Google Drive: токены сохранены.");
    await refreshAll();
    refreshCloudWebhooks();
  };

  /** Everything that happens after any successful sign-in. */
  const finishSignIn = async (
    provider: "onedrive" | "gdrive",
    label: string,
  ): Promise<void> => {
    await globalConfig.set("activeProvider", provider);
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider(provider);
    void vscode.window.showInformationMessage(`${label}: токены сохранены.`);
    await refreshAll();
    refreshCloudWebhooks();
  };

  const oneDrivePkce = async (): Promise<void> => {
    const clientId = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("onedriveClientId", "");
    if (!clientId) {
      await vscode.window.showErrorMessage(
        `Задайте vscodesync.onedriveClientId в настройках. Redirect URI в Azure: ${ONEDRIVE_PKCE_REDIRECT_URI}`,
      );
      return;
    }
    oneDriveOutputChannel.clear();
    oneDriveOutputChannel.show(true);
    oneDriveOutputChannel.appendLine(`OAuth redirect (должен совпадать с приложением Azure): ${ONEDRIVE_PKCE_REDIRECT_URI}`);
    oneDriveOutputChannel.appendLine("");
    try {
      await runOneDrivePkceOAuth(context.secrets, clientId, (authUrl: string) => {
        oneDriveOutputChannel.appendLine("Authorization URL:");
        oneDriveOutputChannel.appendLine(authUrl);
        oneDriveOutputChannel.appendLine("");
        void vscode.window.showInformationMessage("Откройте браузер для входа в OneDrive (URL также в Output).");
        void vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      oneDriveOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(
        // `redirect_uri_mismatch` is the one failure a user can fix themselves,
        // and it is the likely one for an app registered before this flow
        // existed — so the message names the URI instead of just relaying it.
        `OneDrive: ${msg}\n\nЕсли ошибка про redirect_uri — добавьте в приложение Azure ${ONEDRIVE_PKCE_REDIRECT_URI} либо войдите через Device Code.`,
      );
      return;
    }
    await finishSignIn("onedrive", "OneDrive");
  };

  const googleDrivePkce = async (): Promise<void> => {
    const clientId = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("googleDriveClientId", "");
    if (!clientId) {
      await vscode.window.showErrorMessage(
        `Задайте vscodesync.googleDriveClientId в настройках. Redirect URI: ${GDRIVE_PKCE_REDIRECT_URI}`,
      );
      return;
    }
    googleDriveOutputChannel.clear();
    googleDriveOutputChannel.show(true);
    googleDriveOutputChannel.appendLine(`OAuth redirect: ${GDRIVE_PKCE_REDIRECT_URI}`);
    googleDriveOutputChannel.appendLine(
      "Для клиента типа «Desktop app» Google принимает loopback на любом порту — отдельная регистрация URI обычно не нужна.",
    );
    googleDriveOutputChannel.appendLine("");
    try {
      await runGdrivePkceOAuth(context.secrets, clientId, (authUrl: string) => {
        googleDriveOutputChannel.appendLine("Authorization URL:");
        googleDriveOutputChannel.appendLine(authUrl);
        googleDriveOutputChannel.appendLine("");
        void vscode.window.showInformationMessage("Откройте браузер для входа в Google Drive (URL также в Output).");
        void vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      googleDriveOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(
        `Google Drive: ${msg}\n\nЕсли ошибка про redirect_uri — проверьте, что тип клиента «Desktop app», либо войдите через Device Code.`,
      );
      return;
    }
    await finishSignIn("gdrive", "Google Drive");
  };

  const dropbox = async (openBrowser: boolean): Promise<void> => {
    const appKey = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("dropboxAppKey", "");
    if (!appKey) {
      await vscode.window.showErrorMessage(
        `Задайте vscodesync.dropboxAppKey в настройках. Redirect URI в Dropbox Console: ${DROPBOX_OAUTH_REDIRECT_URI}`,
      );
      return;
    }
    dropboxOutputChannel.clear();
    dropboxOutputChannel.show(true);
    dropboxOutputChannel.appendLine(`OAuth redirect (must match Dropbox app): ${DROPBOX_OAUTH_REDIRECT_URI}`);
    dropboxOutputChannel.appendLine("");
    try {
      await runDropboxOAuthLoopback(context.secrets, appKey, (authUrl: string) => {
        dropboxOutputChannel.appendLine("Authorization URL:");
        dropboxOutputChannel.appendLine(authUrl);
        dropboxOutputChannel.appendLine("");
        if (openBrowser) {
          void vscode.window.showInformationMessage("Откройте браузер для входа в Dropbox (URL также в Output).");
          void vscode.env.openExternal(vscode.Uri.parse(authUrl));
        } else {
          void vscode.window.showInformationMessage(
            "Dropbox OAuth: откройте URL из панели Output (VSCodeSync · Dropbox).",
          );
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dropboxOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(`Dropbox: ${msg}`);
      return;
    }
    await globalConfig.set("activeProvider", "dropbox");
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider("dropbox");
    void vscode.window.showInformationMessage("Dropbox: токены сохранены.");
    await refreshAll();
    refreshCloudWebhooks();
  };

  const yandexDisk = async (openBrowser: boolean): Promise<void> => {
    const yandexCfg = vscode.workspace.getConfiguration(CFG_SECTION);
    const clientId = yandexCfg.get<string>("yandexOAuthClientId", "");
    const useAppFolder = yandexCfg.get<boolean>("yandexUseAppFolder", false);
    if (!clientId) {
      await vscode.window.showErrorMessage(
        `Задайте vscodesync.yandexOAuthClientId в настройках. Redirect URI в Яндекс OAuth: ${YANDEX_OAUTH_REDIRECT_URI}`,
      );
      return;
    }
    yandexOutputChannel.clear();
    yandexOutputChannel.show(true);
    yandexOutputChannel.appendLine(`OAuth redirect (должен совпадать с приложением Яндекса): ${YANDEX_OAUTH_REDIRECT_URI}`);
    if (useAppFolder) {
      yandexOutputChannel.appendLine("Режим: папка приложения (scope: cloud_api:disk.app_folder)");
    }
    yandexOutputChannel.appendLine("");
    try {
      await runYandexOAuthLoopback(context.secrets, clientId, (authUrl: string) => {
        yandexOutputChannel.appendLine("Authorization URL:");
        yandexOutputChannel.appendLine(authUrl);
        yandexOutputChannel.appendLine("");
        if (openBrowser) {
          void vscode.window.showInformationMessage("Откройте браузер для входа в Яндекс (URL также в Output).");
          void vscode.env.openExternal(vscode.Uri.parse(authUrl));
        } else {
          void vscode.window.showInformationMessage(
            "Yandex OAuth: откройте URL из панели Output (VSCodeSync · Yandex Disk).",
          );
        }
      }, useAppFolder);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      yandexOutputChannel.appendLine(`Error: ${msg}`);
      await vscode.window.showErrorMessage(`Yandex Disk: ${msg}`);
      return;
    }
    await globalConfig.set("activeProvider", "yandex");
    await globalConfig.save();
    workspacesTree.setActiveCloudProvider("yandex");
    void vscode.window.showInformationMessage("Яндекс Диск: токены сохранены.");
    await refreshAll();
    refreshCloudWebhooks();
  };

  return { oneDrive, googleDrive, oneDrivePkce, googleDrivePkce, dropbox, yandexDisk };
}
