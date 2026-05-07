/**
 * Live presence heartbeat — periodically refreshes this machine's `lastSeen`
 * in cloud `_machines.json`. Lets other machines see who's online without
 * waiting for the next sync cycle.
 *
 * Off by default: `vscodesync.presenceHeartbeatMinutes` = 0. Recommended values:
 * 5 (responsive, ~12 req/h), 15 (lightweight). Below 1 minute is rejected.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { syncMachinesRegistrySelf } from "../core/machineRegistry.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "../core/syncWorkspaceInstanceReadOnly.js";
import { warnLog, verboseLog } from "../utils/log.js";

export interface PresenceHeartbeatDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
}

export function registerPresenceHeartbeat(
  context: vscode.ExtensionContext,
  deps: PresenceHeartbeatDeps,
): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  // Guards against overlapped invocations when the cloud call takes longer
  // than the configured interval. Without it, two parallel ticks can both
  // bump `_machines.json` and create a duplicate registry entry.
  let running = false;

  const reschedule = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    const minutes = vscode.workspace
      .getConfiguration("vscodesync")
      .get<number>("presenceHeartbeatMinutes", 0);
    if (minutes < 1) return;
    const intervalMs = Math.max(60_000, minutes * 60_000);
    verboseLog("presence", `heartbeat enabled, every ${String(minutes)} min`);
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runTick();
    } finally {
      running = false;
    }
  };

  const runTick = async (): Promise<void> => {
    if (syncSessionPause.isPaused()) return;
    if (isSecondaryWorkspaceInstanceReadOnly()) return;
    try {
      const provider = await deps.tryAuthenticatedProvider();
      if (!provider) return;
      const gc = await deps.globalConfig.load();
      await syncMachinesRegistrySelf(provider, gc.machineId, gc.machineName);
      verboseLog("presence", "heartbeat ok");
    } catch (e: unknown) {
      warnLog("presence", `heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.presenceHeartbeatMinutes")) {
        reschedule();
      }
    }),
    new vscode.Disposable(() => {
      if (timer !== undefined) clearInterval(timer);
    }),
  );

  reschedule();
}
