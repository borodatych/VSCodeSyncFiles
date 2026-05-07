/**
 * Background weekly Health Check.
 *
 * Reads `vscodesync.health.lastCheckMs` from globalState; if more than
 * `HEALTH_CHECK_INTERVAL_DAYS` have passed since the last run, schedules an
 * automatic check shortly after activation. Notification is shown only when
 * the report contains warning lines (`⚠`) — silent on green.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { ProviderType } from "../core/types.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import type { SyncScheduleDeferredStore } from "../core/syncScheduleDeferredStore.js";
import { buildHealthCheckReport } from "./healthCheckReport.js";
import { warnLog, verboseLog } from "../utils/log.js";

const STATE_KEY = "vscodesync.health.lastCheckMs";
const HEALTH_CHECK_INTERVAL_DAYS = 7;
const STARTUP_DELAY_MS = 60_000; // run 1 minute after activation, never blocks startup

export interface HealthAutoDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  createEngine: (folderRoot: string, cloud: ICloudProvider) => SyncEngine;
  activeProvider: ProviderType | null;
  machineId: string;
  machineName: string;
  offlineQueue: SyncOfflineQueueStore;
  scheduleDeferred: SyncScheduleDeferredStore;
}

export function registerHealthAutoCheck(
  context: vscode.ExtensionContext,
  deps: HealthAutoDeps,
): void {
  const timer = setTimeout(() => {
    void runIfDue(context, deps);
  }, STARTUP_DELAY_MS);
  context.subscriptions.push(new vscode.Disposable(() => { clearTimeout(timer); }));
}

async function runIfDue(
  context: vscode.ExtensionContext,
  deps: HealthAutoDeps,
): Promise<void> {
  try {
    const lastMs = context.globalState.get<number>(STATE_KEY) ?? 0;
    const now = Date.now();
    const dueMs = HEALTH_CHECK_INTERVAL_DAYS * 24 * 3600_000;
    if (now - lastMs < dueMs) {
      verboseLog("healthAuto", `not due yet (last run ${String(now - lastMs)}ms ago)`);
      return;
    }
    const provider = await deps.tryAuthenticatedProvider();
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return;

    const report = await buildHealthCheckReport({
      workspaceFolders: folders,
      globalConfig: deps.globalConfig,
      activeProviderType: deps.activeProvider,
      provider,
      machineId: deps.machineId,
      machineName: deps.machineName,
      createEngine: deps.createEngine,
      offlineQueue: deps.offlineQueue,
      scheduleDeferred: deps.scheduleDeferred,
    });

    await context.globalState.update(STATE_KEY, now);

    const warnings = report.lines.filter((l) => l.includes("⚠"));
    if (warnings.length === 0) {
      verboseLog("healthAuto", "all green — silent");
      return;
    }
    warnLog("healthAuto", `weekly auto check: ${String(warnings.length)} warnings`);
    const choice = await vscode.window.showWarningMessage(
      `VSCodeSync Health: ${String(warnings.length)} ${warnings.length === 1 ? "проблема" : "проблем(ы)"}. Открыть отчёт?`,
      "Открыть отчёт",
      "Позже",
    );
    if (choice === "Открыть отчёт") {
      await vscode.commands.executeCommand("vscodesync.healthCheck");
    }
  } catch (e: unknown) {
    warnLog("healthAuto", `failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
