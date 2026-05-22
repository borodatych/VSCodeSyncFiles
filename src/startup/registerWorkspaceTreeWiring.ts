/**
 * Workspaces tree + DnD wiring — extracted from `extension.ts`
 * (Phase 0 / v2.11.3).
 *
 * Owns the boot-time wiring around the `vscodesync.workspaces` TreeView:
 *   - `WorkspacesTreeDnD` controller with the cross-workspace move handler.
 *   - `workspacesTree.setFetchRemoteSummaries` callback that builds an engine
 *     on demand and queries `listRemoteWorkspaceSummaries()`.
 *   - The TreeView itself (`createTreeView`) and its filter chrome.
 *   - Tree-data → badge refresh subscription.
 *
 * Returns the `treeView` so command bundles that need it as a `Deps` field
 * (`registerViewManagementCommands`, `registerWorkspaceTreeContextCommands`)
 * can keep their existing contracts.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspacesTreeDnD } from "../ui/workspacesTreeDnD.js";
import {
  type SyncTreeElement,
  type WorkspacesTreeProvider,
} from "../ui/workspacesTree.js";
import { applyWorkspacesTreeFilterChrome } from "../ui/workspacesTreeFilterState.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { trackedLocalAbsolutePath } from "../core/pathMapping.js";
import { guardPathsBeforeAdd } from "../ui/syncGuards.js";
import { pickRoot } from "../commands/_shared.js";
import { ensureProvider } from "../commands/_providerFactory.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { RunWithEngineFn } from "../commands/registerWorkspaceLifecycle.js";

export interface WorkspaceTreeWiringDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  workspacesTree: WorkspacesTreeProvider;
  runWithEngine: RunWithEngineFn;
  makeEngine: (
    root: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
  ) => SyncEngine;
  updateBadge: (tv: vscode.TreeView<SyncTreeElement>) => Promise<void>;
}

export interface WorkspaceTreeWiringHandle {
  treeView: vscode.TreeView<SyncTreeElement>;
}

export function registerWorkspaceTreeWiring(
  deps: WorkspaceTreeWiringDeps,
): WorkspaceTreeWiringHandle {
  const { context, globalConfig, registry, workspacesTree, runWithEngine, makeEngine, updateBadge } = deps;

  const workspacesTreeDnD = new WorkspacesTreeDnD({
    onMoveFilesToWorkspace: async ({ folderRoot, targetWorkspaceId, sources }) => {
      const wc = await WorkspaceConfigManager.load(folderRoot);
      const gconf = await globalConfig.load();
      const ent = wc.activeWorkspaces.find((w) => w.workspaceId === targetWorkspaceId);
      const absPaths = sources.map((s) =>
        trackedLocalAbsolutePath(folderRoot, wc.pathMapping, gconf.machineName, s.localPath),
      );
      if (
        !(await guardPathsBeforeAdd(absPaths, false, folderRoot, {
          entry: ent,
          cfg: wc,
          machineName: gconf.machineName,
        }))
      ) {
        return;
      }
      await runWithEngine(async (engine) => {
        for (const s of sources) {
          const abs = path.join(folderRoot, ...s.localPath.split("/"));
          await engine.removeTrackedFiles(s.workspaceId, [abs]);
          await engine.addFiles(targetWorkspaceId, [abs]);
        }
        void vscode.window.showInformationMessage(
          sources.length === 1
            ? "Файл перемещён в другой workspace."
            : `Перемещено файлов: ${String(sources.length)}.`,
        );
      }, folderRoot);
    },
  });

  workspacesTree.setFetchRemoteSummaries(async () => {
    const root = pickRoot();
    if (!root) return [];
    const provider = await ensureProvider(registry, globalConfig);
    if (!provider) return [];
    const cfg = await globalConfig.load();
    const engine = makeEngine(root, provider, cfg.machineId, cfg.machineName);
    return engine.listRemoteWorkspaceSummaries();
  });

  const treeView = vscode.window.createTreeView("vscodesync.workspaces", {
    treeDataProvider: workspacesTree,
    showCollapseAll: false,
    dragAndDropController: workspacesTreeDnD,
  });
  context.subscriptions.push(treeView);
  void applyWorkspacesTreeFilterChrome(treeView, workspacesTree);

  context.subscriptions.push(
    workspacesTree.onDidChangeTreeData(() => {
      void updateBadge(treeView);
    }),
  );
  void updateBadge(treeView);

  return { treeView };
}
