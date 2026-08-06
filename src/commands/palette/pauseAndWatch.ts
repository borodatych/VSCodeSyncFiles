/**
 * Session pause and watch mode — palette commands.
 *
 * Пауза сессии и watch-режим: включение, выключение, быстрый выбор длительности.
 *
 * Вынесено из `ui/plannedPaletteCommands.ts` (F12): 27 команд из семи доменов
 * жили в одном файле на 1115 строк, и добавление любой новой команды делало
 * его ещё менее читаемым.
 */
import * as vscode from "vscode";
import { syncSessionPause } from "../../core/syncSessionPause.js";
import type { PaletteExtras } from "./_shared.js";
import { CFG } from "./_shared.js";

export function registerPauseAndWatch(
  context: vscode.ExtensionContext,
  extras: PaletteExtras,
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
        void vscode.window.showInformationMessage(
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
      void vscode.window.showInformationMessage("VSCodeSync: Resume — пауза снята.");
    }),
    vscode.commands.registerCommand("vscodesync.smartPauseDropdown", async () => {
      const cfg = vscode.workspace.getConfiguration("vscodesync");
      type Mode = "off" | "metered" | "battery" | "all" | "manual";
      const meterOn = cfg.get<boolean>("pauseOnMeteredConnection", false);
      const batThr = cfg.get<number>("pauseBatteryThreshold", 0);
      const cur: Mode =
        meterOn && batThr > 0
          ? "all"
          : meterOn
            ? "metered"
            : batThr > 0
              ? "battery"
              : "off";
      const items: (vscode.QuickPickItem & { value: Mode; thr?: number })[] = [
        { label: "$(circle-slash) Off", description: "Авто-паузу выключить", value: "off", picked: cur === "off" },
        { label: "$(plug) Metered only", description: "Пауза при metered-соединении", value: "metered", picked: cur === "metered" },
        { label: "$(zap) Battery <30%", description: "Пауза при низкой батарее", value: "battery", thr: 30, picked: cur === "battery" },
        { label: "$(warning) Battery+Metered (max savings)", description: "Включить обе авто-паузы", value: "all", thr: 30, picked: cur === "all" },
        { label: "$(debug-pause) Toggle manual pause", description: "Ручная пауза текущей сессии", value: "manual" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: "VSCodeSync · авто-пауза",
        placeHolder: `Текущий режим: ${cur}`,
      });
      if (!pick) return;
      if (pick.value === "manual") {
        await vscode.commands.executeCommand("vscodesync.togglePause");
        return;
      }
      const meter = pick.value === "metered" || pick.value === "all";
      const batteryThr = pick.value === "battery" || pick.value === "all" ? (pick.thr ?? 30) : 0;
      await cfg.update("pauseOnMeteredConnection", meter, vscode.ConfigurationTarget.Global);
      await cfg.update("pauseBatteryThreshold", batteryThr, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        `VSCodeSync auto-pause: metered=${meter ? "on" : "off"}, battery<${String(batteryThr)}%${batteryThr === 0 ? " (off)" : ""}.`,
      );
    }),

    vscode.commands.registerCommand("vscodesync.enableWatchMode", async () => {
      await configuration().update("watchMode", true, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        "VSCodeSync: watchMode включён — фоновый полный sync по интервалу (см. watchIntervalSeconds); на глобальной паузе опрос останавливается.",
      );
    }),
    vscode.commands.registerCommand("vscodesync.disableWatchMode", async () => {
      await configuration().update("watchMode", false, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage("VSCodeSync: watchMode выключен.");
    }),
    vscode.commands.registerCommand("vscodesync.toggleWatchMode", async () => {
      const cfg = configuration();
      const next = !cfg.get<boolean>("watchMode", false);
      await cfg.update("watchMode", next, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`VSCodeSync: watchMode — ${next ? "вкл" : "выкл"}.`);
    }),
  );
}
