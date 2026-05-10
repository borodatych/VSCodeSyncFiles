/**
 * v2.6.7 — observer wiring extracted from `extension.ts`.
 *
 * Bundles three opt-in passive observers that have no return surface:
 *   - SmartConflictPredictionService (status-bar over machines.json)
 *   - presence heartbeat (opt-in via `presenceHeartbeatMinutes`)
 *   - cross-cloud backup mirror (opt-in via `backup.secondaryProvider`)
 *
 * They share a single dependency shape (`globalConfig`, `registry`) and
 * none of them produces wiring that the rest of `activate()` needs to
 * thread through, so packing them into one helper is purely mechanical.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { tryAuthenticatedProvider } from "../commands/_providerFactory.js";
import { SmartConflictPredictionService } from "../ui/smartConflictPredictionService.js";
import { registerPresenceHeartbeat } from "../ui/presenceHeartbeat.js";
import { registerCrossCloudBackup } from "../ui/crossCloudBackup.js";

export interface ObserverWiringDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
}

export function registerObservers(deps: ObserverWiringDeps): void {
  const { context, globalConfig, registry } = deps;

  const conflictPredictor = new SmartConflictPredictionService(
    globalConfig,
    () => tryAuthenticatedProvider(registry),
  );
  conflictPredictor.start();
  context.subscriptions.push(conflictPredictor);

  registerPresenceHeartbeat(context, {
    globalConfig,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
  });

  registerCrossCloudBackup(context, {
    globalConfig,
    registry,
    tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
  });
}
