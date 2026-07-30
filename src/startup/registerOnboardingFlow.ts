/**
 * Onboarding + companion startup flows — extracted from `extension.ts`
 * (Phase 0 / v2.11.3).
 *
 * Bundles the post-bootstrap one-shot flows that all run inside `void (async)`
 * IIFEs and don't share state with the rest of activate():
 *   - Timeline provider registration (runtime registerTimelineProvider).
 *   - `.gitignore` self-entry for each open workspace folder.
 *   - Machines-registry self-sync (only if onboarding is already completed).
 *   - Onboarding wizard (only if onboarding is NOT completed).
 *   - Weekly Health-Auto-Check (silent green, toast on warnings).
 *   - Custom URI handler `vscode://borodatych.vscodesyncfiles/connect?...` for
 *     share-link based workspace import.
 *
 * Returns the Timeline-provider's "fire change" hook so the activity-log
 * dispatcher in extension.ts can notify it on new sync events.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderType } from "../core/types.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import type { SyncScheduleDeferredStore } from "../core/syncScheduleDeferredStore.js";
import { tryAuthenticatedProvider } from "../commands/_providerFactory.js";
import { ensureWorkspaceGitignoreEntry } from "../core/workspaceGitignore.js";
import { syncMachinesRegistrySelf } from "../core/machineRegistry.js";
import { runOnboardingWizard } from "../ui/onboarding.js";
import { SyncTimelineProvider } from "../ui/syncTimelineProvider.js";
import { registerHealthAutoCheck } from "../ui/healthAutoCheck.js";

export interface OnboardingFlowDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  statusBar: SyncStatusBarController;
  workspacesTree: WorkspacesTreeProvider;
  offlineQueueStore: SyncOfflineQueueStore;
  scheduleDeferredStore: SyncScheduleDeferredStore;
  makeEngine: (
    root: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
  workspaceFolders: () => readonly vscode.WorkspaceFolder[];
}

export interface OnboardingFlowHandle {
  /** Bound `timelineProvider.fireChange()` — call on every new activity row. */
  readonly fireTimelineChange: () => void;
}

export function registerOnboardingFlow(deps: OnboardingFlowDeps): OnboardingFlowHandle {
  const {
    context,
    globalConfig,
    registry,
    statusBar,
    workspacesTree,
    offlineQueueStore,
    scheduleDeferredStore,
    makeEngine,
    workspaceFolders,
  } = deps;

  const timelineProvider = new SyncTimelineProvider(globalConfig);
  try {
    // Timeline API is stable in VSCode 1.44+ but not yet in @types/vscode@1.80 — runtime registration.
    const reg = (vscode.window as unknown as {
      registerTimelineProvider?: (...args: unknown[]) => vscode.Disposable;
    }).registerTimelineProvider;
    if (typeof reg === "function") {
      context.subscriptions.push(reg.call(vscode.window, "file", timelineProvider));
    }
  } catch {
    // Non-fatal: Timeline integration unavailable in this VSCode build
  }
  context.subscriptions.push(timelineProvider);

  for (const wf of workspaceFolders()) {
    void ensureWorkspaceGitignoreEntry(wf.uri, vscode.window.showInformationMessage);
  }

  void (async () => {
    try {
      const c = await globalConfig.load();
      if (!c.onboardingCompleted) return;
      const p = await tryAuthenticatedProvider(registry);
      if (!p) return;
      await syncMachinesRegistrySelf(p, c.machineId, c.machineName);
    } catch {
      /* не блокируем старт */
    }
  })();

  void (async () => {
    const c = await globalConfig.load();
    if (c.onboardingCompleted) return;
    await runOnboardingWizard(globalConfig, {
      tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
      onActiveProviderChanged: (t: ProviderType) => {
        workspacesTree.setActiveCloudProvider(t);
      },
    });
    await statusBar.refresh();
    workspacesTree.refresh();
  })();

  void (async () => {
    const gcInit = await globalConfig.load();
    registerHealthAutoCheck(context, {
      globalConfig,
      tryAuthenticatedProvider: () => tryAuthenticatedProvider(registry),
      // Automatic health check — read-only (`healthCheckWorkspace`).
      createEngine: (root, p) => makeEngine(root, p, gcInit.machineId, gcInit.machineName, "auto"),
      activeProvider: gcInit.activeProvider,
      machineId: gcInit.machineId,
      machineName: gcInit.machineName,
      offlineQueue: offlineQueueStore,
      scheduleDeferred: scheduleDeferredStore,
    });
  })();

  // v0.8.3 — `vscode://borodatych.vscodesyncfiles/connect?…` URI handler
  // moved into the single dispatcher in `vscodeSyncUriHandler.ts`. Two
  // separate `registerUriHandler` calls in one extension hit VS Code's
  // "one UriHandler per extension" limit and threw "Protocol handler
  // already registered" in strict hosts (VibeIDE), failing activate().

  return {
    fireTimelineChange: () => { timelineProvider.fireChange(); },
  };
}
