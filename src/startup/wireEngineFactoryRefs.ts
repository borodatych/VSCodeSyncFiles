/**
 * Engine-factory ref wiring — extracted from `extension.ts` (stage 3, B5).
 *
 * The factory's `setRefs(...)` bundle keeps growing as engine callbacks gain
 * user-facing follow-ups (repush after remote deletion, applying reported
 * tracking drift). Each of those is a small `runWithEngine` closure, and
 * `extension.ts` has a hard LOC ceiling — so the whole bundle lives here and
 * `activate()` makes exactly one call.
 */
import * as vscode from "vscode";
import type { RunWithEngineFn } from "../commands/registerWorkspaceLifecycle.js";
import type { createEngineFactory } from "./_engineFactory.js";
import type { EngineLogRefs } from "./createEngineLogRefs.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";

export interface WireEngineFactoryRefsDeps {
  engineFactory: ReturnType<typeof createEngineFactory>;
  logRefs: EngineLogRefs;
  runWithEngine: RunWithEngineFn;
  statusBar: SyncStatusBarController;
  workspacesTree: WorkspacesTreeProvider;
  mirrorPushedFile: (workspaceId: string, posixRel: string, plaintext: Buffer) => void;
}

export function wireEngineFactoryRefs(deps: WireEngineFactoryRefsDeps): void {
  const { engineFactory, logRefs, runWithEngine, statusBar, workspacesTree } = deps;

  engineFactory.setRefs({
    logSyncActivity: logRefs.logSyncActivity,
    logSyncStatsTransfer: logRefs.logSyncStatsTransfer,
    logSyncCompression: logRefs.logSyncCompression,
    treeRefresh: () => { workspacesTree.refresh(); },
    repushDeletedWorkspace: async (workspaceId, localRoot, savedEntry, savedFiles) => {
      await runWithEngine(async (engine) => {
        await engine.repushWorkspaceToCloud(workspaceId, savedEntry, savedFiles);
        void vscode.window.showInformationMessage(
          `VSCodeSync: workspace «${savedEntry.workspaceNote || workspaceId}» восстановлен на облаке.`,
        );
      }, localRoot, { trigger: "user" }); // "Залить на облако" in the remote-deletion toast.
      workspacesTree.invalidateRemoteCache();
      workspacesTree.refresh();
      await statusBar.refresh();
    },
    applyTrackingDrift: async (workspaceId) => {
      await runWithEngine(async (engine) => {
        await engine.applyTrackingFromCloud(workspaceId);
      }, undefined, { trigger: "user" }); // "Применить" in the tracking-drift toast.
    },
    mirrorPushedFile: deps.mirrorPushedFile,
  });
}
