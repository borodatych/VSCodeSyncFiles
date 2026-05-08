import * as vscode from "vscode";
import * as os from "node:os";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderType } from "../core/types.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import {
  pickUniqueMachineName,
  readMachinesRegistrySafe,
  syncMachinesRegistrySelf,
} from "../core/machineRegistry.js";
import {
  isOnboardingAlreadyComplete,
  planOnboardingWizard,
  type OnboardingDecision,
  type PlanOnboardingInput,
} from "../core/onboardingWizardSteps.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { suggestMachineNameFrom } from "./machineNameSuggest.js";

const CFG_SECTION = "vscodesync";

function validateMachineNameInput(v: string): string | undefined {
  const t = v.trim();
  if (!t) {
    return "Укажите непустое имя";
  }
  if (t.includes("/") || t.includes("\\")) {
    return "Нельзя использовать / и \\";
  }
  return undefined;
}

export interface OnboardingCloudDeps {
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  onActiveProviderChanged?: (t: ProviderType) => void;
}

async function resolveMachineNameAgainstCloudRegistry(
  globalConfig: GlobalConfigManager,
  provider: ICloudProvider,
): Promise<void> {
  const entries = await readMachinesRegistrySafe(provider);
  if (entries === undefined) {
    return;
  }
  const cfg = await globalConfig.load();
  const desired = cfg.machineName.trim();
  const unique = pickUniqueMachineName(entries, desired, cfg.machineId);
  if (unique === desired) {
    return;
  }
  const useSuggested = await vscode.window.showWarningMessage(
    `Имя «${desired}» уже занято другой машиной в облачном реестре (_machines.json). Использовать «${unique}»?`,
    "Использовать предложенное",
    "Ввести другое имя",
    "Пропустить",
  );
  if (useSuggested === "Использовать предложенное") {
    await globalConfig.set("machineName", unique);
    return;
  }
  if (useSuggested !== "Ввести другое имя") {
    return;
  }
  for (;;) {
    const custom = await vscode.window.showInputBox({
      title: "Имя этой машины (уникальное в облаке)",
      prompt: "Не должно совпадать с именем другой машины в VSCodeSync.",
      value: unique,
      validateInput: validateMachineNameInput,
    });
    if (custom === undefined) {
      return;
    }
    const t = custom.trim();
    const u = pickUniqueMachineName(entries, t, cfg.machineId);
    if (u === t) {
      await globalConfig.set("machineName", t);
      return;
    }
    const accept = await vscode.window.showWarningMessage(
      `«${t}» всё ещё занято. Использовать «${u}»?`,
      "Принять",
      "Повторить ввод",
    );
    if (accept === "Принять") {
      await globalConfig.set("machineName", u);
      return;
    }
    if (accept !== "Повторить ввод") {
      return;
    }
  }
}

async function detectOnboardingState(
  globalConfig: GlobalConfigManager,
  cloudDeps: OnboardingCloudDeps | undefined,
): Promise<PlanOnboardingInput> {
  const cfg = await globalConfig.load();
  const hasActiveProvider = cfg.activeProvider !== null;
  const hasMachineName = cfg.machineName.trim().length > 0;
  let hasAuthenticatedTokens = false;
  if (hasActiveProvider && cloudDeps) {
    try {
      const p = await cloudDeps.tryAuthenticatedProvider();
      hasAuthenticatedTokens = p !== null;
    } catch {
      hasAuthenticatedTokens = false;
    }
  }
  let hasAttachedWorkspace = false;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      if (wc.activeWorkspaces.length > 0) {
        hasAttachedWorkspace = true;
        break;
      }
    } catch {
      /* missing/corrupt vscodesync.json — count as not attached */
    }
  }
  return {
    hasActiveProvider,
    hasAuthenticatedTokens,
    hasMachineName,
    hasAttachedWorkspace,
    preselectedProvider: cfg.activeProvider ?? undefined,
  };
}

function summariseSkippedDecisions(decisions: OnboardingDecision[]): string[] {
  const lines: string[] = [];
  for (const d of decisions) {
    if (d.step === "pick_provider" && d.reason === "skip_already_configured") {
      lines.push("· провайдер уже настроен");
    } else if (d.step === "authenticate_provider" && d.reason === "skip_already_authenticated") {
      lines.push("· провайдер авторизован");
    } else if (d.step === "name_machine" && d.reason === "skip_already_named") {
      lines.push("· имя машины уже задано");
    } else if (d.step === "pick_or_create_workspace" && d.reason === "skip_already_attached") {
      lines.push("· workspace уже подключён");
    }
  }
  return lines;
}

function suggestMachineName(): string {
  const wf = vscode.workspace.workspaceFolders?.[0];
  const authority =
    wf?.uri.scheme === "vscode-remote" && wf.uri.authority.startsWith("ssh-remote+")
      ? wf.uri.authority
      : undefined;
  let host: string | undefined;
  try {
    host = os.hostname() || undefined;
  } catch {
    host = undefined;
  }
  return suggestMachineNameFrom({
    remoteName: vscode.env.remoteName,
    codespaceName: process.env.CODESPACE_NAME,
    githubRepository: process.env.GITHUB_REPOSITORY,
    vscodeRemoteAuthority: authority,
    hostname: host,
  });
}

/**
 * Первичный мастер: имя машины → провайдер → workspace → телеметрия.
 * Не выставляет onboardingCompleted, если пользователь закрыл шаг обязательным образом.
 */
export async function runOnboardingWizard(
  globalConfig: GlobalConfigManager,
  cloudDeps?: OnboardingCloudDeps,
): Promise<void> {
  const planInput = await detectOnboardingState(globalConfig, cloudDeps);
  if (isOnboardingAlreadyComplete(planInput)) {
    const goKeys = await vscode.window.showInformationMessage(
      "VSCodeSync уже настроен — провайдер, машина и workspace на месте.",
      "Открыть Keyboard Shortcuts",
      "Закрыть",
    );
    if (goKeys === "Открыть Keyboard Shortcuts") {
      await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "vscodesync");
    }
    return;
  }
  const plan = planOnboardingWizard(planInput);
  const stepsToRun = new Set(plan.steps);

  if (stepsToRun.has("name_machine")) {
    const name = await vscode.window.showInputBox({
      title: "VSCodeSync — имя этой машины",
      prompt: "Как отображать эту машину (уведомления, история)?",
      value: suggestMachineName(),
      validateInput: validateMachineNameInput,
    });
    if (name === undefined) {
      return;
    }
    await globalConfig.set("machineName", name.trim());
  }

  let providerForAuth: ProviderType | undefined = planInput.preselectedProvider;
  if (stepsToRun.has("pick_provider")) {
    interface ProviderPick {
      label: string;
      description?: string;
      value: ProviderType;
    }
    const currentSuffix = planInput.preselectedProvider
      ? ` (текущий: ${planInput.preselectedProvider})`
      : "";
    const provPick = await vscode.window.showQuickPick<ProviderPick>(
      [
        { label: "OneDrive", description: "Microsoft 365 / личный аккаунт", value: "onedrive" },
        { label: "Google Drive", description: "OAuth device flow · см. googleDriveClientId", value: "gdrive" },
        { label: "Яндекс Диск", value: "yandex" },
        { label: "Dropbox", description: "OAuth PKCE + loopback · см. dropboxAppKey и redirect URI", value: "dropbox" },
      ],
      { title: `VSCodeSync — облачный провайдер${currentSuffix}`, placeHolder: "Выберите провайдер" },
    );
    if (!provPick) {
      return;
    }

    await globalConfig.set("activeProvider", provPick.value);
    await globalConfig.save();
    cloudDeps?.onActiveProviderChanged?.(provPick.value);
    providerForAuth = provPick.value;
  }

  if (stepsToRun.has("authenticate_provider")) {
    if (providerForAuth === "onedrive") {
      const clientId = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("onedriveClientId", "");
      if (!clientId) {
        await vscode.window.showWarningMessage(
          "Укажите vscodesync.onedriveClientId в настройках, затем выполните «VSCodeSync: Sign in to OneDrive».",
        );
      } else {
        const go = await vscode.window.showQuickPick<{ label: string; value: "browser" | "headless" | "later" }>(
          [
            { label: "Войти — открыть браузер на этой машине", value: "browser" },
            { label: "Device Code (headless: браузер на другой машине / SSH)", value: "headless" },
            { label: "Позже", value: "later" },
          ],
          { title: "VSCodeSync — OneDrive", placeHolder: "Способ авторизации Microsoft" },
        );
        if (go?.value === "browser") {
          await vscode.commands.executeCommand("vscodesync.onedriveSignIn");
        } else if (go?.value === "headless") {
          await vscode.commands.executeCommand("vscodesync.onedriveSignInHeadless");
        }
      }
    } else if (providerForAuth === "gdrive") {
      const clientId = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("googleDriveClientId", "");
      if (!clientId) {
        await vscode.window.showWarningMessage(
          "Укажите vscodesync.googleDriveClientId в настройках, затем выполните «VSCodeSync: Sign in to Google Drive».",
        );
      } else {
        const go = await vscode.window.showQuickPick<{ label: string; value: "browser" | "headless" | "later" }>(
          [
            { label: "Войти — открыть браузер на этой машине", value: "browser" },
            { label: "Device Code (headless)", value: "headless" },
            { label: "Позже", value: "later" },
          ],
          { title: "VSCodeSync — Google Drive", placeHolder: "Способ авторизации Google" },
        );
        if (go?.value === "browser") {
          await vscode.commands.executeCommand("vscodesync.googleDriveSignIn");
        } else if (go?.value === "headless") {
          await vscode.commands.executeCommand("vscodesync.googleDriveSignInHeadless");
        }
      }
    } else if (providerForAuth === "dropbox") {
      const key = vscode.workspace.getConfiguration(CFG_SECTION).get<string>("dropboxAppKey", "");
      if (!key) {
        await vscode.window.showWarningMessage(
          "Укажите vscodesync.dropboxAppKey и redirect URI в консоли Dropbox, затем выполните «VSCodeSync: Sign in to Dropbox».",
        );
      } else {
        const go = await vscode.window.showQuickPick<{ label: string; value: "browser" | "headless" | "later" }>(
          [
            { label: "Войти — открыть браузер (OAuth redirect на localhost:8734)", value: "browser" },
            { label: "Только URL в Output (без авто-открытия браузера)", value: "headless" },
            { label: "Позже", value: "later" },
          ],
          { title: "VSCodeSync — Dropbox", placeHolder: "Способ авторизации" },
        );
        if (go?.value === "browser") {
          await vscode.commands.executeCommand("vscodesync.dropboxSignIn");
        } else if (go?.value === "headless") {
          await vscode.commands.executeCommand("vscodesync.dropboxSignInHeadless");
        }
      }
    }
  }

  if (cloudDeps) {
    const p = await cloudDeps.tryAuthenticatedProvider();
    if (p) {
      await resolveMachineNameAgainstCloudRegistry(globalConfig, p);
    }
  }

  if (stepsToRun.has("pick_or_create_workspace")) {
    const wsPick = await vscode.window.showQuickPick<{ label: string; value: "create" | "connect" | "skip" }>(
      [
        { label: "Создать новый workspace", value: "create" },
        { label: "Подключиться к существующему на облаке", value: "connect" },
        { label: "Пропустить — настрою позже", value: "skip" },
      ],
      { title: "VSCodeSync — workspace" },
    );
    if (!wsPick) {
      return;
    }
    if (wsPick.value === "create") {
      if (!vscode.workspace.workspaceFolders?.length) {
        await vscode.window.showWarningMessage(
          "Откройте папку проекта в VS Code, затем выполните «VSCodeSync: Create Workspace».",
        );
      } else {
        await vscode.commands.executeCommand("vscodesync.createWorkspace");
      }
    } else if (wsPick.value === "connect") {
      if (!vscode.workspace.workspaceFolders?.length) {
        await vscode.window.showWarningMessage(
          "Откройте папку проекта в VS Code, затем выполните «VSCodeSync: Connect to Cloud Workspace».",
        );
      } else {
        await vscode.commands.executeCommand("vscodesync.connectCloudWorkspace");
      }
    }
  }

  const telPick = await vscode.window.showQuickPick<{ label: string; value: boolean }>(
    [
      { label: "Не отправлять телеметрию (по умолчанию)", value: false },
      { label: "Разрешить анонимную телеметрию", value: true },
    ],
    { title: "VSCodeSync — телеметрия", placeHolder: "Собираются только события расширения, без путей и содержимого файлов" },
  );
  const telemetry = telPick?.value ?? false;
  await vscode.workspace
    .getConfiguration(CFG_SECTION)
    .update("telemetry", telemetry, vscode.ConfigurationTarget.Global);

  await globalConfig.set("onboardingCompleted", true);
  await globalConfig.save();

  if (cloudDeps) {
    const p = await cloudDeps.tryAuthenticatedProvider();
    if (p) {
      try {
        const fin = await globalConfig.load();
        await syncMachinesRegistrySelf(p, fin.machineId, fin.machineName);
      } catch {
        /* offline / конфликт ETag — не блокируем завершение мастера */
      }
    }
  }

  const skippedLines = summariseSkippedDecisions(plan.decisions);
  const messageLines: string[] = ["VSCodeSync: первичная настройка завершена."];
  if (skippedLines.length > 0) {
    messageLines.push("", "Пропущено (уже настроено):", ...skippedLines);
  }
  messageLines.push(
    "",
    "Часто назначают горячие клавиши на: Push/Pull текущего файла, Push/Pull All, Resolve Conflicts, Open Activity Feed.",
    "Команды без комбинации по умолчанию — задайте в Keyboard Shortcuts (поиск: vscodesync).",
  );
  const goKeys = await vscode.window.showInformationMessage(
    messageLines.join("\n"),
    "Открыть Keyboard Shortcuts",
  );
  if (goKeys === "Открыть Keyboard Shortcuts") {
    await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "vscodesync");
  }
}
