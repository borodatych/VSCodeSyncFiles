import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderType } from "../core/types.js";
import type { WorkspacesTreeProvider } from "./workspacesTree.js";

const ALL: ProviderType[] = ["onedrive", "gdrive", "yandex", "dropbox"];

export function labelForProviderType(t: ProviderType): string {
  switch (t) {
    case "onedrive":
      return "OneDrive";
    case "gdrive":
      return "Google Drive";
    case "yandex":
      return "Яндекс Диск";
    case "dropbox":
      return "Dropbox";
    default: {
      const _: never = t;
      return _;
    }
  }
}

/** Workspaces whose cached manifest `providerType` differs from the target (excludes entries without cache). */
export async function countWorkspacesNotOnProvider(target: ProviderType): Promise<number> {
  let n = 0;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
    for (const e of wc.activeWorkspaces) {
      if (e.providerType != null && e.providerType !== target) {
        n += 1;
      }
    }
  }
  return n;
}

export interface RunActiveProviderSwitchParams {
  registry: ProviderRegistry;
  globalConfig: GlobalConfigManager;
  workspacesTree: WorkspacesTreeProvider;
  signInOneDrive: () => Promise<void>;
  signInGoogleDrive: () => Promise<void>;
  signInDropbox: () => Promise<void>;
  signInYandexDisk: () => Promise<void>;
  refreshStatusAndPanels: () => Promise<void>;
}

export async function runActiveProviderSwitch(p: RunActiveProviderSwitchParams): Promise<void> {
  const cfg = await p.globalConfig.load();
  const current = cfg.activeProvider;

  const items: {
    label: string;
    description: string;
    type: ProviderType;
    authed: boolean;
  }[] = [];

  for (const t of ALL) {
    const authed = await p.registry.isAuthenticatedFor(t);
    const base = labelForProviderType(t);
    const label = base;
    const descParts: string[] = [];
    if (current === t) {
      descParts.push("текущий");
    }
    descParts.push(authed ? "авторизован" : "не авторизован — выполните вход");
    items.push({ label, description: descParts.join(" · "), type: t, authed });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Активный провайдер (один на все workspace'ы)",
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }

  if (!picked.authed) {
    if (picked.type === "onedrive") {
      await p.signInOneDrive();
      const ok = await p.registry.isAuthenticatedFor("onedrive");
      if (!ok) {
        await vscode.window.showWarningMessage("VSCodeSync: вход в OneDrive не завершён — провайдер не переключён.");
        return;
      }
    } else if (picked.type === "gdrive") {
      await p.signInGoogleDrive();
      const ok = await p.registry.isAuthenticatedFor("gdrive");
      if (!ok) {
        await vscode.window.showWarningMessage("VSCodeSync: вход в Google Drive не завершён — провайдер не переключён.");
        return;
      }
    } else if (picked.type === "dropbox") {
      await p.signInDropbox();
      const ok = await p.registry.isAuthenticatedFor("dropbox");
      if (!ok) {
        await vscode.window.showWarningMessage("VSCodeSync: вход в Dropbox не завершён — провайдер не переключён.");
        return;
      }
    } else {
      await p.signInYandexDisk();
      const ok = await p.registry.isAuthenticatedFor("yandex");
      if (!ok) {
        await vscode.window.showWarningMessage("VSCodeSync: вход в Яндекс Диск не завершён — провайдер не переключён.");
        return;
      }
    }
  }

  const foreign = await countWorkspacesNotOnProvider(picked.type);
  if (foreign > 0) {
    const answer = await vscode.window.showWarningMessage(
      `У вас есть workspace'ы из манифеста другого провайдера (${String(foreign)}). Они будут скрыты в боковой панели. Для переноса используйте «VSCodeSync: Migrate to Another Provider».`,
      { modal: true },
      "Продолжить",
      "Отмена",
    );
    if (answer !== "Продолжить") {
      return;
    }
  }

  await p.globalConfig.set("activeProvider", picked.type);
  await p.globalConfig.save();
  p.workspacesTree.setActiveCloudProvider(picked.type);
  await p.refreshStatusAndPanels();
  void vscode.window.showInformationMessage(`VSCodeSync: активный провайдер — ${labelForProviderType(picked.type)}.`);
}
