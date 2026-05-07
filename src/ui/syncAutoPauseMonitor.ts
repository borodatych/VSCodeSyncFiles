import * as vscode from "vscode";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { readBatteryPercent } from "../utils/batteryPercent.js";
import { readNavigatorMetered } from "../utils/networkMetered.js";

const CFG = "vscodesync";

function getCfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CFG);
}

/**
 * Polls metered (navigator) + battery (OS). Updates `syncAutoPause` and shows edge notifications.
 */
export function registerAutoPauseMonitor(context: vscode.ExtensionContext): void {
  const tick = async (): Promise<void> => {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
      const before = syncAutoPause.isActive();
      syncAutoPause.commitPollingSnapshot({ metered: false, battery: false });
      const after = syncAutoPause.isActive();
      edgeNotify(before, after, getCfg().get<number>("pauseBatteryThreshold", 15));
      return;
    }

    const meteredSetting = getCfg().get<boolean>("pauseOnMeteredConnection", true);
    let meteredPause = false;
    if (meteredSetting) {
      const raw = readNavigatorMetered();
      meteredPause = raw === true;
    }

    const threshold = getCfg().get<number>("pauseBatteryThreshold", 15);
    let batteryPause = false;
    if (threshold > 0) {
      const pct = await readBatteryPercent();
      if (pct !== null && pct < threshold) {
        batteryPause = true;
      }
    }

    const before = syncAutoPause.isActive();
    syncAutoPause.commitPollingSnapshot({ metered: meteredPause, battery: batteryPause });
    const after = syncAutoPause.isActive();
    edgeNotify(before, after, threshold);
  };

  const id = setInterval(() => {
    void tick().catch(() => {
      /* polling best-effort */
    });
  }, 30000);

  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearInterval(id);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CFG}.pauseOnMeteredConnection`) ||
        e.affectsConfiguration(`${CFG}.pauseBatteryThreshold`)
      ) {
        void tick().catch(() => {
          /* ignore */
        });
      }
    }),
  );

  void tick().catch(() => {
    /* ignore */
  });
}

function edgeNotify(before: boolean, after: boolean, threshold: number): void {
  if (!before && after) {
    const r = syncAutoPause.getReason();
    const detail =
      r === "metered"
        ? "тарифицируемое / лимитированное соединение"
        : r === "battery"
          ? `заряд батареи ниже порога (${String(threshold)}%)`
          : "условия экономии";
    void vscode.window.showInformationMessage(`☁ VSCodeSync: авто-пауза автосинка — ${detail}. Ручные команды доступны.`);
  } else if (before && !after) {
    void vscode.window.showInformationMessage("☁ VSCodeSync: авто-пауза снята — автосинхронизация возобновлена.");
  }
}
