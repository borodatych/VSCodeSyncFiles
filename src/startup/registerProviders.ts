/**
 * v2.6.7 — provider registry registration extracted from `extension.ts`.
 *
 * Each provider needs the `vscode` SDK + the extension's `SecretStorage` +
 * its current `clientId` setting. Bundling the four registrations into a
 * single function keeps `extension.ts` focused on orchestration; nothing
 * here is conditional on user state.
 */
import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry.js";
import { OneDriveProvider } from "../providers/onedrive/onedriveProvider.js";
import { GdriveProvider } from "../providers/gdrive/gdriveProvider.js";
import { YandexDiskProvider } from "../providers/yandex/yandexDiskProvider.js";
import { DropboxProvider } from "../providers/dropbox/dropboxProvider.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";

const CFG = "vscodesync";

export interface RegisterProvidersDeps {
  readonly context: vscode.ExtensionContext;
  readonly globalConfig: GlobalConfigManager;
}

/** Build a `ProviderRegistry` populated with all four supported providers.
 *  Caller owns the lifetime; no `context.subscriptions` mutation here. */
export function registerProviders(deps: RegisterProvidersDeps): ProviderRegistry {
  const { context, globalConfig } = deps;
  const registry = new ProviderRegistry(() => globalConfig.load());
  registry.register("onedrive", () => new OneDriveProvider(context.secrets));
  registry.register(
    "gdrive",
    () =>
      new GdriveProvider(context.secrets, () => {
        const raw = vscode.workspace.getConfiguration(CFG).get<string>("googleDriveClientId", "");
        return typeof raw === "string" ? raw : "";
      }),
  );
  registry.register("yandex", () => {
    const cfg = vscode.workspace.getConfiguration(CFG);
    const useAppFolder = cfg.get<boolean>("yandexUseAppFolder", false);
    return new YandexDiskProvider(
      context.secrets,
      () => {
        const raw = vscode.workspace.getConfiguration(CFG).get<string>("yandexOAuthClientId", "");
        return typeof raw === "string" ? raw : "";
      },
      useAppFolder,
    );
  });
  registry.register(
    "dropbox",
    () =>
      new DropboxProvider(context.secrets, () => {
        const raw = vscode.workspace.getConfiguration(CFG).get<string>("dropboxAppKey", "");
        return typeof raw === "string" ? raw : "";
      }),
  );
  return registry;
}
