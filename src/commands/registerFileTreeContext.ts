/**
 * Files TreeView context-menu command bundle — eighth tranche of the
 * `extension.ts` decomposition (v2.6 in the roadmap).
 *
 * Holds the 7 commands triggered from the right-click menu on file
 * nodes (push / pull / show-history / open-in-cloud / 3 conflict +
 * lock-resolution variants).
 *
 * Same contract as the prior bundles. The mutable `logSyncActivityRef`
 * is exposed as a `logSyncActivity` callback (deps wraps the
 * null-check), so the bundle never sees the underlying ref.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ActivityEventInput } from "../core/activityLog.js";
import { trackedLocalAbsolutePath } from "../core/pathMapping.js";
import { guardPathsBeforePush } from "../ui/syncGuards.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import type { WorkspacesTreeProvider, SyncTreeElement } from "../ui/workspacesTree.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { openTrackedFileInCloudStorage, runShowFileHistory } from "./_engineFlows.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface FileTreeContextCommandsDeps {
  globalConfig: GlobalConfigManager;
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
  fileDecorations: SyncFileDecorationController;
  registry: ProviderRegistry;
  refreshActiveEditor: () => void;
  runWithEngine: RunWithEngineFn;
  logSyncActivity: (ev: ActivityEventInput) => void;
}

export function registerFileTreeContextCommands(
  deps: FileTreeContextCommandsDeps,
): vscode.Disposable[] {
  const {
    globalConfig,
    workspacesTree,
    statusBar,
    fileDecorations,
    registry,
    refreshActiveEditor,
    runWithEngine,
    logSyncActivity,
  } = deps;
  const showFileHistoryAt = (target: { root: string; fsPath: string }): Promise<void> =>
    runShowFileHistory(runWithEngine, globalConfig, target);
  const openTrackedFileInCloudStorageAt = (target: { root: string; fsPath: string }): Promise<void> =>
    openTrackedFileInCloudStorage(registry, globalConfig, target);

  return [
    vscode.commands.registerCommand(
      "vscodesync.treeFilePush",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "file") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        const wc = await WorkspaceConfigManager.load(rootPath);
        const gconf = await globalConfig.load();
        const abs = trackedLocalAbsolutePath(rootPath, wc.pathMapping, gconf.machineName, el.localPath);
        if (!(await guardPathsBeforePush([abs]))) {
          return;
        }
        await runWithEngine(async (engine, root) => {
          const cfg = await WorkspaceConfigManager.load(root);
          const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
          if (!entry) {
            await vscode.window.showErrorMessage("Workspace не найден в конфиге.");
            return;
          }
          await engine.pushFile(cfg, el.workspaceId, el.localPath, entry);
          void vscode.window.showInformationMessage(`Push ${el.localPath}: готово.`);
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeFilePull",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "file") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        await runWithEngine(async (engine, root) => {
          const cfg = await WorkspaceConfigManager.load(root);
          const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
          if (!entry) {
            await vscode.window.showErrorMessage("Workspace не найден в конфиге.");
            return;
          }
          const result = await engine.pullFile(cfg, el.workspaceId, el.localPath, entry);
          if (result === "already_current") {
            void vscode.window.showInformationMessage(`${el.localPath}: уже актуален.`);
          } else {
            void vscode.window.showInformationMessage(`Pull ${el.localPath}: готово.`);
          }
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand("vscodesync.treeFileShowHistory", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const wc = await WorkspaceConfigManager.load(el.folderRoot.fsPath);
      const gconf = await globalConfig.load();
      const abs =
        el.resolvedFsPath ??
        trackedLocalAbsolutePath(el.folderRoot.fsPath, wc.pathMapping, gconf.machineName, el.localPath);
      await showFileHistoryAt({ root: el.folderRoot.fsPath, fsPath: abs });
    }),

    vscode.commands.registerCommand("vscodesync.treeFileOpenInCloud", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const wc = await WorkspaceConfigManager.load(el.folderRoot.fsPath);
      const gconf = await globalConfig.load();
      const abs =
        el.resolvedFsPath ??
        trackedLocalAbsolutePath(el.folderRoot.fsPath, wc.pathMapping, gconf.machineName, el.localPath);
      await openTrackedFileInCloudStorageAt({ root: el.folderRoot.fsPath, fsPath: abs });
    }),

    vscode.commands.registerCommand("vscodesync.treeFileKeepMine", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const rootPath = el.folderRoot.fsPath;
      const cfg = await WorkspaceConfigManager.load(rootPath);
      const gconf = await globalConfig.load();
      const wnote =
        cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId)?.workspaceNote ?? el.workspaceId;
      for (const f of cfg.files) {
        if (f.workspaceId === el.workspaceId && f.localPath === el.localPath) {
          f.syncStatus = "ok";
        }
      }
      await WorkspaceConfigManager.save(cfg, rootPath);
      logSyncActivity({
        kind: "resolve_keep_mine",
        workspaceId: el.workspaceId,
        workspaceNote: wnote,
        relPath: el.localPath,
        machineName: gconf.machineName,
        provider: gconf.activeProvider ?? "onedrive",
      });
      void vscode.window.showInformationMessage("Конфликт снят (локально); при необходимости выполните Push.");
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
    }),

    vscode.commands.registerCommand("vscodesync.treeFileTakeTheirs", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const rootPath = el.folderRoot.fsPath;
      await runWithEngine(async (engine, root) => {
        let cfg = await WorkspaceConfigManager.load(root);
        const row = cfg.files.find((f) => f.workspaceId === el.workspaceId && f.localPath === el.localPath);
        if (row?.syncStatus !== "conflict") {
          await vscode.window.showWarningMessage("VSCodeSync: нет конфликта для этого файла.");
          return;
        }
        row.syncStatus = "ok";
        await WorkspaceConfigManager.save(cfg, root);
        cfg = await WorkspaceConfigManager.load(root);
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден.");
          return;
        }
        await engine.pullFile(cfg, el.workspaceId, el.localPath, entry);
        const gconf = await globalConfig.load();
        const wnote =
          cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId)?.workspaceNote ?? el.workspaceId;
        logSyncActivity({
          kind: "resolve_take_theirs",
          workspaceId: el.workspaceId,
          workspaceNote: wnote,
          relPath: el.localPath,
          machineName: gconf.machineName,
          provider: gconf.activeProvider ?? "onedrive",
        });
        void vscode.window.showInformationMessage(`Принята облачная версия: ${el.localPath}`);
      }, rootPath);
    }),

    vscode.commands.registerCommand("vscodesync.treeFileForceSync", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const who = el.editingByName ?? el.editingBy ?? "другой машины";
      const picked = await vscode.window.showWarningMessage(
        `Файл «${path.basename(el.localPath)}» редактируется на «${who}». Принудительно отправить свою версию в облако?`,
        { modal: true },
        "Force Sync",
      );
      if (picked !== "Force Sync") {
        return;
      }
      const rootPath = el.folderRoot.fsPath;
      await runWithEngine(async (engine, root) => {
        let cfg = await WorkspaceConfigManager.load(root);
        const row = cfg.files.find((f) => f.workspaceId === el.workspaceId && f.localPath === el.localPath);
        if (!row) {
          await vscode.window.showErrorMessage("VSCodeSync: файл не найден в конфигурации.");
          return;
        }
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден.");
          return;
        }
        delete row.editingBy;
        delete row.editingByName;
        row.syncStatus = "ok";
        await WorkspaceConfigManager.save(cfg, root);
        cfg = await WorkspaceConfigManager.load(root);
        await engine.pushFile(cfg, el.workspaceId, el.localPath, entry);
        await WorkspaceConfigManager.save(cfg, root);
        const gconf = await globalConfig.load();
        const wnote = cfg.activeWorkspaces.find((w) => w.workspaceId === el.workspaceId)?.workspaceNote ?? el.workspaceId;
        logSyncActivity({
          kind: "resolve_keep_mine",
          workspaceId: el.workspaceId,
          workspaceNote: wnote,
          relPath: el.localPath,
          machineName: gconf.machineName,
          provider: gconf.activeProvider ?? "onedrive",
        });
        void vscode.window.showInformationMessage(`Force Sync выполнен: ${el.localPath}`);
      }, rootPath);
      workspacesTree.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
    }),
  ];
}
