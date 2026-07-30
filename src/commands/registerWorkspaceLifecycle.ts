/**
 * Workspace lifecycle command bundle — fourth tranche of the `extension.ts`
 * decomposition (v2.6 in the roadmap).
 *
 * Holds the 8 commands that move a workspace through its
 * Active / Suspended / Frozen / Archived lifecycle plus the cloud-side
 * delete and encrypted-purge commands. Validation goes through the
 * shared `validateWorkspaceTransition` helper (which delegates to the
 * `workspaceSuspendStateMachine` core module).
 *
 * Same contract as `registerProviderSignIn.ts`:
 *   - All deps come in via `WorkspaceLifecycleCommandsDeps`.
 *   - Each `register…` returns a Disposable list; caller pushes into
 *     `context.subscriptions`.
 *   - `runWithEngine` arrives as a function — keeps this module free of
 *     `ProviderRegistry` / encryption / engine-construction details.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import { hasArchivedTag } from "../utils/workspaceLastActivity.js";
import { applyArchivedTagAndSuspend, stripArchivedTagAndActivate } from "../ui/workspaceArchiveOps.js";
import { confirmTreeWorkspaceBulkSyncIfNeeded } from "../ui/syncPreviewUi.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";
import { type SyncTreeElement, type WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import {
  pickRoot,
  pickWorkspaceId,
  pickWorkspaceIdMatching,
  validateWorkspaceTransition,
} from "./_shared.js";

export type RunWithEngineFn = (
  fn: (engine: SyncEngine, root: string, gc: GlobalConfigManager) => Promise<void>,
  workspaceRoot?: string,
  options?: {
    showErrorDialog?: boolean;
    /**
     * Mutation trigger for the engine this wrapper builds (F2). Omitted means
     * `"user"`, which is the wrapper's contract: it exists to serve palette
     * commands and menu items, all of which are a human acting.
     *
     * Entry points that are *not* commands must say so. The one today is the
     * `vscodesync` task provider — a task with `runOn: folderOpen` runs itself,
     * and VS Code gives the provider no way to tell that apart from a manual
     * run.
     */
    trigger?: SyncTrigger;
  },
) => Promise<void>;

export interface WorkspaceLifecycleCommandsDeps {
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
  fileDecorations: SyncFileDecorationController;
  syncPreviewChannel: vscode.OutputChannel;
  refreshActiveEditor: () => void;
  runWithEngine: RunWithEngineFn;
}

export function registerWorkspaceLifecycleCommands(
  deps: WorkspaceLifecycleCommandsDeps,
): vscode.Disposable[] {
  const {
    workspacesTree,
    statusBar,
    fileDecorations,
    syncPreviewChannel,
    refreshActiveEditor,
    runWithEngine,
  } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.suspendWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => normalizeWorkspaceSyncState(e) === "active" && !hasArchivedTag(e.tags),
          "VSCodeSync: нет workspace в состоянии «активен» (без archived).",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const v = await validateWorkspaceTransition(root, wsId, "suspend");
      if (!v.ok) {
        await vscode.window.showWarningMessage(v.warning);
        return;
      }
      const ws = wsId;
      const rt = root;
      const next = v.newState;
      await runWithEngine(
        async (engine) => {
          await engine.setWorkspaceSyncState(ws, next);
          void vscode.window.showInformationMessage(
            "VSCodeSync: workspace приостановлен (Suspend) — push/pull файлов отключены; манифест можно обновлять.",
          );
        },
        rt,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.resumeWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => normalizeWorkspaceSyncState(e) === "suspended" && !hasArchivedTag(e.tags),
          "VSCodeSync: нет workspace в режиме Suspend (без archived).",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const v = await validateWorkspaceTransition(root, wsId, "resume");
      if (!v.ok) {
        await vscode.window.showWarningMessage(v.warning);
        return;
      }
      const ws = wsId;
      const rt = root;
      const next = v.newState;
      await runWithEngine(
        async (engine) => {
          await engine.setWorkspaceSyncState(ws, next);
          void vscode.window.showInformationMessage("VSCodeSync: workspace снова активен (Resume).");
        },
        rt,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.archiveWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      let noteLabel: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        noteLabel = el.note || el.workspaceId;
        const wc = await WorkspaceConfigManager.load(root);
        const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
        if (
          !ent ||
          normalizeWorkspaceSyncState(ent) !== "active" ||
          hasArchivedTag(ent.tags)
        ) {
          await vscode.window.showWarningMessage(
            "VSCodeSync: архивировать можно только активный workspace без тега archived.",
          );
          return;
        }
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => normalizeWorkspaceSyncState(e) === "active" && !hasArchivedTag(e.tags),
          "VSCodeSync: нет подходящего workspace (нужен Active без archived).",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const lab = noteLabel ?? wsId;
      const confirm = await vscode.window.showWarningMessage(
        `Архивировать «${lab}»? Будут добавлен тег archived и режим Suspend; строка скроется из списка, пока не включён показ архивных.`,
        { modal: true },
        "Архивировать",
      );
      if (confirm !== "Архивировать") {
        return;
      }
      const ws = wsId;
      const rt = root;
      await runWithEngine(
        async (engine) => {
          await applyArchivedTagAndSuspend(engine, ws);
          void vscode.window.showInformationMessage(
            "VSCodeSync: workspace архивирован (archived + Suspend). Включите «Toggle Show Archived», чтобы видеть строку.",
          );
        },
        rt,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.unarchiveWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      let noteLabel: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        noteLabel = el.note || el.workspaceId;
        if (!hasArchivedTag(el.tags)) {
          await vscode.window.showWarningMessage(
            "VSCodeSync: разархивировать можно только workspace с тегом archived.",
          );
          return;
        }
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => hasArchivedTag(e.tags),
          "VSCodeSync: нет workspace с тегом archived.",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
      if (!ent) {
        await vscode.window.showWarningMessage("VSCodeSync: workspace не найден в vscodesync.json.");
        return;
      }
      const prior = normalizeWorkspaceSyncState(ent);
      const lab = noteLabel ?? (ent.workspaceNote.trim() ? ent.workspaceNote : wsId);
      const ws = wsId;
      await runWithEngine(
        async (engine) => {
          const proceed = await confirmTreeWorkspaceBulkSyncIfNeeded(
            engine,
            syncPreviewChannel,
            ws,
            lab,
            "pull",
          );
          if (!proceed) {
            return;
          }
          await stripArchivedTagAndActivate(engine, ws, prior);
          await engine.pullAll(ws);
          void vscode.window.showInformationMessage("VSCodeSync: workspace разархивирован; Pull выполнен.");
        },
        root,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
    }),

    vscode.commands.registerCommand("vscodesync.freezeWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      let noteLabel: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        noteLabel = el.note || el.workspaceId;
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => {
            const st = normalizeWorkspaceSyncState(e);
            return (st === "active" || st === "suspended") && !hasArchivedTag(e.tags);
          },
          "VSCodeSync: нет подходящего workspace для Freeze.",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const v = await validateWorkspaceTransition(root, wsId, "freeze");
      if (!v.ok) {
        await vscode.window.showWarningMessage(v.warning);
        return;
      }
      const lab = noteLabel ?? wsId;
      const confirm = await vscode.window.showWarningMessage(
        `Заморозить «${lab}» (Freeze)? Запись манифеста и файлов на облако будет заблокирована.`,
        { modal: true },
        "Freeze",
      );
      if (confirm !== "Freeze") {
        return;
      }
      const ws = wsId;
      const rt = root;
      const next = v.newState;
      await runWithEngine(
        async (engine) => {
          await engine.setWorkspaceSyncState(ws, next);
          void vscode.window.showInformationMessage(
            "VSCodeSync: Freeze — без push/pull и без записи манифеста/_meta.",
          );
        },
        rt,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.unfreezeWorkspace", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceIdMatching(
          root,
          (e) => normalizeWorkspaceSyncState(e) === "frozen",
          "VSCodeSync: нет workspace в режиме Freeze.",
        );
      }
      if (!wsId || !root) {
        return;
      }
      const v = await validateWorkspaceTransition(root, wsId, "unfreeze", { skipArchivedCheck: true });
      if (!v.ok) {
        await vscode.window.showWarningMessage(v.warning);
        return;
      }
      const ws = wsId;
      const rt = root;
      const next = v.newState;
      await runWithEngine(async (engine) => {
        await engine.setWorkspaceSyncState(ws, next);
        await engine.repairLocalStateFromCloud(ws);
        await engine.syncWorkspace(ws);
        void vscode.window.showInformationMessage(
          "VSCodeSync: Freeze снят — подтянуты метаданные с облака и выполнен sync workspace.",
        );
      }, rt);
      workspacesTree.refresh();
      await statusBar.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
    }),

    vscode.commands.registerCommand("vscodesync.deleteWorkspaceFromCloud", async (arg?: unknown) => {
      let root: string | undefined;
      let wsId: string | undefined;
      let noteLabel: string | undefined;
      if (arg && typeof arg === "object" && (arg as SyncTreeElement).kind === "workspace") {
        const el = arg as SyncTreeElement & { kind: "workspace" };
        root = el.folderRoot.fsPath;
        wsId = el.workspaceId;
        noteLabel = el.note || el.workspaceId;
      } else {
        root = pickRoot();
        if (!root) {
          return;
        }
        wsId = await pickWorkspaceId(root);
        if (!wsId) {
          return;
        }
        const wc = await WorkspaceConfigManager.load(root);
        noteLabel = wc.activeWorkspaces.find((w) => w.workspaceId === wsId)?.workspaceNote ?? wsId;
      }
      if (!wsId || !root) {
        return;
      }
      const lab = noteLabel;
      const localFilesAction = await vscode.window.showWarningMessage(
        `Удалить workspace «${lab}» (${wsId}) с облака?\n\nВсе файлы в VSCodeSyncFiles/${wsId}/ будут удалены без восстановления.\nЧто делать с локальными копиями на этом компьютере?`,
        { modal: true },
        "Удалить с облака, локальные оставить",
        "Удалить с облака и удалить локально",
        "Только отвязать здесь",
      );
      if (!localFilesAction) {
        return;
      }
      const ws = wsId;
      const rt = root;
      await runWithEngine(
        async (engine) => {
          if (localFilesAction === "Только отвязать здесь") {
            await engine.detachWorkspaceLocal(ws);
            workspacesTree.refresh();
            void vscode.window.showInformationMessage(
              `VSCodeSync: workspace ${ws} отвязан локально. Облако и локальные файлы не тронуты.`,
            );
          } else if (localFilesAction === "Удалить с облака и удалить локально") {
            const wc = await WorkspaceConfigManager.load(rt);
            const savedEntry = wc.activeWorkspaces.find((e) => e.workspaceId === ws);
            const savedFiles = wc.files.filter((f) => f.workspaceId === ws);
            const localPaths = savedFiles.map((f) => path.join(rt, ...f.localPath.split("/")));

            workspacesTree.markPendingDelete(ws);
            workspacesTree.invalidateRemoteCache();
            await engine.detachWorkspaceLocal(ws);
            workspacesTree.refresh();

            try {
              await engine.deleteCloudFilesOnly(ws);
            } catch (cloudErr) {
              workspacesTree.clearPendingDelete(ws);
              if (savedEntry) {
                await engine.restoreWorkspaceLocal(savedEntry, savedFiles);
              }
              workspacesTree.refresh();
              await vscode.window.showErrorMessage(
                `VSCodeSync: не удалось удалить workspace ${ws} с облака. Workspace восстановлен локально. Ошибка: ${String(cloudErr instanceof Error ? cloudErr.message : cloudErr)}`,
              );
              return;
            }

            workspacesTree.clearPendingDelete(ws);
            workspacesTree.invalidateRemoteCache();

            let deletedCount = 0;
            for (const p of localPaths) {
              try {
                await fs.unlink(p);
                deletedCount++;
              } catch {
                /* file may already be gone */
              }
            }
            workspacesTree.refresh();
            void vscode.window.showInformationMessage(
              `VSCodeSync: workspace ${ws} удалён с облака. Удалено локально: ${String(deletedCount)} файлов.`,
            );
          } else {
            // "Удалить с облака, локальные оставить"
            const wc = await WorkspaceConfigManager.load(rt);
            const savedEntry = wc.activeWorkspaces.find((e) => e.workspaceId === ws);
            const savedFiles = wc.files.filter((f) => f.workspaceId === ws);

            workspacesTree.markPendingDelete(ws);
            workspacesTree.invalidateRemoteCache();
            await engine.detachWorkspaceLocal(ws);
            workspacesTree.refresh();

            try {
              await engine.deleteCloudFilesOnly(ws);
            } catch (cloudErr) {
              workspacesTree.clearPendingDelete(ws);
              if (savedEntry) {
                await engine.restoreWorkspaceLocal(savedEntry, savedFiles);
              }
              workspacesTree.refresh();
              await vscode.window.showErrorMessage(
                `VSCodeSync: не удалось удалить workspace ${ws} с облака. Workspace восстановлен локально. Ошибка: ${String(cloudErr instanceof Error ? cloudErr.message : cloudErr)}`,
              );
              return;
            }

            workspacesTree.clearPendingDelete(ws);
            workspacesTree.invalidateRemoteCache();
            workspacesTree.refresh();
            void vscode.window.showInformationMessage(
              `VSCodeSync: workspace ${ws} удалён с облака. Локальные файлы не тронуты.`,
            );
          }
        },
        rt,
      );
      await statusBar.refresh();
      fileDecorations.refresh();
      refreshActiveEditor();
    }),

    vscode.commands.registerCommand("vscodesync.purgeEncryptedWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const wsId = await pickWorkspaceId(root);
      if (!wsId) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const ws = wc.activeWorkspaces.find((w) => w.workspaceId === wsId);
      const label = ws?.workspaceNote ?? wsId;
      const confirm = await vscode.window.showWarningMessage(
        `Удалить зашифрованные облачные данные workspace «${label}» (${wsId})? Все файлы в VSCodeSyncFiles/${wsId}/ будут уничтожены. Локальные копии останутся. Операция необратима.`,
        { modal: true },
        "Удалить",
      );
      if (confirm !== "Удалить") {
        return;
      }
      await runWithEngine(
        async (engine) => {
          await engine.deleteWorkspaceFromCloud(wsId);
          void vscode.window.showInformationMessage(
            `VSCodeSync: зашифрованные данные workspace ${wsId} удалены с облака. Локальный конфиг отключён.`,
          );
        },
        root,
      );
      workspacesTree.refresh();
      await statusBar.refresh();
      fileDecorations.refresh();
    }),
  ];
}
