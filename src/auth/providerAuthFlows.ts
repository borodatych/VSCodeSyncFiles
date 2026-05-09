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
    await vscode.window.showInformationMessage("OneDrive: токены сохранены.");
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
    await vscode.window.showInformationMessage("Google Drive: токены сохранены.");
    await refreshAll();
    refreshCloudWebhooks();
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
    await vscode.window.showInformationMessage("Dropbox: токены сохранены.");
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
    await vscode.window.showInformationMessage("Яндекс Диск: токены сохранены.");
    await refreshAll();
    refreshCloudWebhooks();
  };

  return { oneDrive, googleDrive, dropbox, yandexDisk };
}
