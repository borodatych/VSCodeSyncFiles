/**
 * Cross-module provider helpers — `ensureProvider` (with sign-in
 * warnings for unauth state) + `tryAuthenticatedProvider` (silent
 * lookup). Both used by extension.ts startup and by command bundles
 * that need ad-hoc provider access without going through `runWithEngine`.
 *
 * Lifted out of extension.ts as part of v2.6.7 (extension.ts < 500 LoC
 * goal). Pure top-level functions — no closures over activate scope.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { OneDriveProvider } from "../providers/onedrive/onedriveProvider.js";
import { GdriveProvider } from "../providers/gdrive/gdriveProvider.js";
import { DropboxProvider } from "../providers/dropbox/dropboxProvider.js";
import { YandexDiskProvider } from "../providers/yandex/yandexDiskProvider.js";

/** Resolve the active provider, default to OneDrive if none configured,
 * and surface a warning toast if the resolved provider is unauthenticated. */
export async function ensureProvider(
  registry: ProviderRegistry,
  globalConfig: GlobalConfigManager,
): Promise<ICloudProvider | null> {
  let cfg = await globalConfig.load();
  if (!cfg.activeProvider) {
    await globalConfig.set("activeProvider", "onedrive");
    await globalConfig.save();
    cfg = await globalConfig.load();
  }
  const p = await registry.getActive();
  if (!p) {
    await vscode.window.showErrorMessage("VSCodeSync: нет активного провайдера в реестре.");
    return null;
  }
  if (p instanceof OneDriveProvider && !(await p.isAuthenticated())) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: OneDrive не авторизован. Sign in to OneDrive или выберите другой провайдер.",
    );
  }
  if (p instanceof GdriveProvider && !(await p.isAuthenticated())) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: Google Drive не авторизован. Sign in to Google Drive или выберите другой провайдер.",
    );
  }
  if (p instanceof DropboxProvider && !(await p.isAuthenticated())) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: Dropbox не авторизован. Sign in to Dropbox или выберите другой провайдер.",
    );
  }
  if (p instanceof YandexDiskProvider && !(await p.isAuthenticated())) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: Яндекс Диск не авторизован. Sign in to Yandex Disk или выберите другой провайдер.",
    );
  }
  return p;
}

/** Silent variant: returns the active provider only if it's authenticated.
 * Never shows UI. Use it when you'd skip the action rather than ask the
 * user to sign in. */
export async function tryAuthenticatedProvider(
  registry: ProviderRegistry,
): Promise<ICloudProvider | null> {
  const p = await registry.getActive();
  if (!p) {
    return null;
  }
  try {
    return (await p.isAuthenticated()) ? p : null;
  } catch {
    return null;
  }
}
