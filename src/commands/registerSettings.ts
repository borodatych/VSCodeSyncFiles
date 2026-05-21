/**
 * Settings / status command bundle — sixth tranche of the `extension.ts`
 * decomposition (v2.6 in the roadmap).
 *
 * Holds 5 light-weight commands that interact with the configuration
 * surface (notification level, telemetry toggle), open the settings UI,
 * or display a one-line status / dashboard.
 *
 * Same contract as the prior bundles — all deps come in via the
 * interface; no module-level state.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";

const CFG_SECTION = "vscodesync";

export interface SettingsCommandsDeps {
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  statusBar: SyncStatusBarController;
}

export function registerSettingsCommands(deps: SettingsCommandsDeps): vscode.Disposable[] {
  const { globalConfig, registry, statusBar } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.setNotificationLevel", async () => {
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const cur = cfg.get<string>("notificationLevel", "normal");
      const picked = await vscode.window.showQuickPick(
        [
          { label: "minimal", description: "Только ошибки", value: "minimal" as const },
          { label: "normal", description: "Стандартные уведомления", value: "normal" as const },
          { label: "verbose", description: "Подробные сообщения", value: "verbose" as const },
        ],
        { placeHolder: `Сейчас: ${cur}` },
      );
      if (!picked) {
        return;
      }
      await cfg.update("notificationLevel", picked.value, vscode.ConfigurationTarget.Global);
      await vscode.window.showInformationMessage(`VSCodeSync: уровень уведомлений — ${picked.label}`);
    }),

    vscode.commands.registerCommand("vscodesync.showStatus", async () => {
      const cfg = await globalConfig.load();
      const p = await registry.getActive();
      const name = (p?.type ?? cfg.activeProvider ?? "none") as string;
      await vscode.window.showInformationMessage(
        `VSCodeSync · ${cfg.machineName} · провайдер: ${name}`,
      );
    }),

    vscode.commands.registerCommand("vscodesync.openSyncSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:vscodesync.vscodesync");
    }),

    vscode.commands.registerCommand("vscodesync.toggleTelemetry", async () => {
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const cur = cfg.get<boolean>("telemetry", false);
      await cfg.update("telemetry", !cur, vscode.ConfigurationTarget.Global);
      const vscodeOff = !vscode.env.isTelemetryEnabled;
      if (cur) {
        await vscode.window.showInformationMessage(
          "VSCodeSync: расширение больше не отправляет события (vscodesync.telemetry): выкл.",
        );
      } else {
        await vscode.window.showInformationMessage(
          vscodeOff
            ? "VSCodeSync: телеметрия расширения включена. Чтобы события уходили в Microsoft / инструменты разработчика, включите телеметрию в настройках VS Code. Внешняя отправка — только при непустом vscodesync.telemetryIngestUrl."
            : "VSCodeSync: телеметрия расширения включена. События без путей к файлам; внешний endpoint — только при заданном vscodesync.telemetryIngestUrl.",
        );
      }
    }),

    vscode.commands.registerCommand("vscodesync.showSyncSummary", async () => {
      await statusBar.showDashboard();
    }),

    vscode.commands.registerCommand("vscodesync.cycleAutoSyncMode", async () => {
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const cur = cfg.get<string>("autoSyncMode", "check-only");
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: "off",
            description: "Никакой автосинхронизации. Push / Pull / Sync — только вручную.",
            value: "off" as const,
          },
          {
            label: "check-only",
            description:
              "Только проверять статусы (cloud_newer / pending_push / conflict). Push / Pull — вручную. Рекомендуется при работе с одним workspace на нескольких машинах.",
            value: "check-only" as const,
          },
          {
            label: "full",
            description:
              "Полная синхронизация: push на save (debounce), pull на open, full sync на focus, watch poll. Историческое поведение.",
            value: "full" as const,
          },
        ],
        { placeHolder: `Сейчас: ${cur}` },
      );
      if (!picked) return;
      await cfg.update("autoSyncMode", picked.value, vscode.ConfigurationTarget.Global);
      await statusBar.refresh();
      await vscode.window.showInformationMessage(
        `VSCodeSync · авто-режим: ${picked.label}`,
      );
    }),
  ];
}
