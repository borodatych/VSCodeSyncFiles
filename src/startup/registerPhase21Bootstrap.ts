/**
 * v0.15 — single-line wiring for Phase 21 helpers.
 *
 * Bundles four wiring entries so `extension.ts` stays slim:
 *   - command bundle (`registerPhase21Commands`)
 *   - contextual hints scheduler
 *   - `vscodesync://` URI handler
 *   - `.gitignore` watcher
 *
 * Without this bootstrap, `extension.ts` adds 4 imports + 10 lines.
 * With it, just 1 import + 1 call.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { RunWithEngineFn } from "../commands/registerWorkspaceLifecycle.js";
import { registerPhase21Commands } from "../commands/registerPhase21Commands.js";
import { registerContextualHintsScheduler } from "../ui/contextualHintsScheduler.js";
import { registerVscodeSyncUriHandler } from "../ui/vscodeSyncUriHandler.js";
import { registerGitignoreWatcher } from "../ui/gitignoreWatcher.js";
import { registerConnectivityProbeWidget } from "../ui/connectivityProbeWidget.js";
import { registerVscodesyncRcWatcher } from "../ui/vscodesyncRcWatcher.js";
import { registerTrustedTeammatesCommands } from "../ui/trustedTeammatesUi.js";

export interface Phase21BootstrapDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  runWithEngine: RunWithEngineFn;
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
  ) => SyncEngine;
}

export function registerPhase21Bootstrap(deps: Phase21BootstrapDeps): void {
  const { context } = deps;
  context.subscriptions.push(...registerPhase21Commands({
    globalConfig: deps.globalConfig,
    registry: deps.registry,
    tryAuthenticatedProvider: deps.tryAuthenticatedProvider,
    runWithEngine: deps.runWithEngine,
    makeEngine: deps.makeEngine,
  }));
  context.subscriptions.push(registerContextualHintsScheduler({
    context,
    globalConfig: deps.globalConfig,
  }));
  registerVscodeSyncUriHandler(context, deps.globalConfig);
  context.subscriptions.push(registerGitignoreWatcher(context));
  context.subscriptions.push(registerConnectivityProbeWidget({
    context,
    tryAuthenticatedProvider: deps.tryAuthenticatedProvider,
  }));
  context.subscriptions.push(registerVscodesyncRcWatcher(context));
  context.subscriptions.push(...registerTrustedTeammatesCommands(context));
}
