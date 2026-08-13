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
import { keepMineWithCloudMovedPrompt } from "../ui/conflictKeepMinePrompt.js";
import { chooseMissingFilePlacement } from "./_placementFlow.js";
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

type FileElement = Extract<SyncTreeElement, { kind: "file" }>;

/**
 * The file nodes a tree command should act on. VS Code hands context-menu
 * commands `(clickedItem, selection[])`; the click target is not always in the
 * selection, and the selection can mix in folder/workspace nodes. Multi-root
 * batches are refused rather than half-executed — every downstream call is
 * scoped to one workspace root.
 */
function selectedFiles(
  clicked: SyncTreeElement | undefined,
  selection: readonly SyncTreeElement[] | undefined,
): FileElement[] {
  const pool = selection && selection.length > 0 ? selection : clicked ? [clicked] : [];
  const files = pool.filter((e): e is FileElement => e.kind === "file");
  if (files.length === 0) {
    return [];
  }
  const root = files[0].folderRoot.fsPath;
  const sameRoot = files.filter((f) => f.folderRoot.fsPath === root);
  if (sameRoot.length !== files.length) {
    void vscode.window.showWarningMessage(
      "VSCodeSync: выделены файлы из разных папок проекта — выполнено только для первой.",
    );
  }
  // The clicked node wins when the user right-clicks outside their selection.
  if (clicked?.kind === "file" && !sameRoot.some((f) => f.localPath === clicked.localPath)) {
    return [clicked];
  }
  return sameRoot;
}

/** One toast per batch: N done, M already current, failures named. */
function reportBatch(
  verb: string,
  done: number,
  failed: readonly string[],
  total: number,
  alreadyCurrent = 0,
): void {
  if (total === 1 && failed.length === 0) {
    void vscode.window.showInformationMessage(
      alreadyCurrent === 1 ? `${verb}: уже актуален.` : `${verb}: готово.`,
    );
    return;
  }
  const parts = [`${verb}: ${String(done)} из ${String(total)}`];
  if (alreadyCurrent > 0) parts.push(`уже актуальны: ${String(alreadyCurrent)}`);
  if (failed.length > 0) parts.push(`ошибок: ${String(failed.length)}`);
  const text = `VSCodeSync — ${parts.join(", ")}`;
  if (failed.length > 0) {
    void vscode.window.showWarningMessage(`${text}. ${failed[0]}${failed.length > 1 ? " …" : ""}`);
  } else {
    void vscode.window.showInformationMessage(text);
  }
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
      async (el: SyncTreeElement | undefined, selection?: readonly SyncTreeElement[]) => {
        const files = selectedFiles(el, selection);
        if (files.length === 0) {
          return;
        }
        const rootPath = files[0].folderRoot.fsPath;
        const wc = await WorkspaceConfigManager.load(rootPath);
        const gconf = await globalConfig.load();
        const absPaths = files.map((f) =>
          trackedLocalAbsolutePath(rootPath, wc.pathMapping, gconf.machineName, f.localPath),
        );
        // One guard call for the whole batch — the check is about the paths,
        // and asking N times is how a bulk action becomes unusable.
        if (!(await guardPathsBeforePush(absPaths))) {
          return;
        }
        await runWithEngine(async (engine, root) => {
          const cfg = await WorkspaceConfigManager.load(root);
          let done = 0;
          const failed: string[] = [];
          for (const f of files) {
            const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === f.workspaceId);
            if (!entry) {
              failed.push(`${f.localPath}: workspace не найден в конфиге`);
              continue;
            }
            try {
              await engine.pushFile(cfg, f.workspaceId, f.localPath, entry);
              done += 1;
            } catch (e) {
              failed.push(`${f.localPath}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          reportBatch("Push", done, failed, files.length);
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeFilePull",
      async (el: SyncTreeElement | undefined, selection?: readonly SyncTreeElement[]) => {
        const files = selectedFiles(el, selection);
        if (files.length === 0) {
          return;
        }
        const rootPath = files[0].folderRoot.fsPath;

        // Link Bindings (stage 2) — placement choice for a file that has no
        // bytes on this machine yet: sender's structure, a custom spot (bind +
        // pull), or bind to an existing local file (no download at all).
        // A batch asks ONCE for the whole set (same contract as Pull All);
        // per-file questions are opt-in.
        const pullRelByPath = new Map<string, string>();
        const missing = files.filter((f) => f.syncStatus === "missing_local");
        let perFile = missing.length > 0 && files.length === 1;
        if (missing.length > 0 && files.length > 1) {
          const choice = await vscode.window.showInformationMessage(
            `${String(missing.length)} из ${String(files.length)} файлов ещё нет на этой машине. ` +
              "Разложить их по записанным путям (структура воркспейса или ваши привязки)?",
            { modal: true },
            "Принять",
            "Разобрать по одному",
          );
          if (choice === undefined) {
            return;
          }
          perFile = choice === "Разобрать по одному";
        }
        if (perFile) {
          for (const f of missing) {
            const outcome = await chooseMissingFilePlacement(
              runWithEngine,
              f.folderRoot,
              f.workspaceId,
              f.localPath,
              f.manifestPath ?? f.localPath,
            );
            if (outcome.kind === "cancelled") {
              return;
            }
            if (outcome.kind !== "pull") {
              // Bound to an existing local file — nothing to download.
              pullRelByPath.set(f.localPath, "");
              continue;
            }
            pullRelByPath.set(f.localPath, outcome.pullRel);
          }
        }

        await runWithEngine(async (engine, root) => {
          const cfg = await WorkspaceConfigManager.load(root);
          let done = 0;
          let current = 0;
          const failed: string[] = [];
          for (const f of files) {
            const pullRel = pullRelByPath.get(f.localPath) ?? f.localPath;
            if (pullRel === "") continue;
            const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === f.workspaceId);
            if (!entry) {
              failed.push(`${f.localPath}: workspace не найден в конфиге`);
              continue;
            }
            try {
              const result = await engine.pullFile(cfg, f.workspaceId, pullRel, entry);
              if (result === "already_current") current += 1;
              else done += 1;
            } catch (e) {
              failed.push(`${f.localPath}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          reportBatch("Pull", done, failed, files.length, current);
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

    // Both tree actions delegate to the engine — they used to be a third copy
    // of conflict resolution (C19): "keep mine" only cleared the flag locally
    // and asked the user to push afterwards, and "take theirs" persisted
    // `syncStatus = "ok"` before the pull, losing the conflict on any failure
    // (C18). Mutating `syncStatus` from the command layer is no longer done
    // anywhere.
    vscode.commands.registerCommand("vscodesync.treeFileKeepMine", async (el: SyncTreeElement | undefined) => {
      if (el?.kind !== "file") {
        return;
      }
      const rootPath = el.folderRoot.fsPath;
      await runWithEngine(async (engine) => {
        const pushed = await keepMineWithCloudMovedPrompt(
          (opts) => engine.resolveConflictKeepMine(el.workspaceId, el.localPath, opts),
          el.localPath,
        );
        if (!pushed) {
          return;
        }
        void vscode.window.showInformationMessage(
          `Конфликт разрешён: оставлена локальная версия «${el.localPath}».`,
        );
      }, rootPath);
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
      await runWithEngine(async (engine) => {
        await engine.resolveConflictTakeTheirs(el.workspaceId, el.localPath);
        void vscode.window.showInformationMessage(`Принята облачная версия: ${el.localPath}`);
      }, rootPath);
      await statusBar.refresh();
      workspacesTree.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
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
