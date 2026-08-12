/**
 * Workspaces TreeView context-menu command bundle — seventh tranche of the
 * `extension.ts` decomposition (v2.6 in the roadmap).
 *
 * Holds the 10 commands triggered from the right-click menu / inline
 * actions on Workspace nodes (and on remote-offer nodes from the
 * "Available on cloud" section):
 *   - treeWorkspace{PushAll,PullAll,Sync,Detach,RenameNote,HealthCheck,
 *                   ShowMenu,AddTagToPanelFilter}
 *   - treeRemoteWorkspace{Connect,Delete}
 *
 * Behaviour preserving — except `treeRemoteWorkspaceDelete` now goes
 * through `runWithEngine` (was inline `ensureProvider + makeEngine`).
 * Side-effect: the status bar briefly shows "syncing" during the delete,
 * which is actually a UX improvement.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { workspaceHealthEmoji, workspaceHealthFromLocalCfg } from "../ui/workspaceHealthLocal.js";
import { confirmTreeWorkspaceBulkSyncIfNeeded } from "../ui/syncPreviewUi.js";
import {
  WORKSPACES_TAG_FILTERS_KEY,
  applyWorkspacesTreeFilterChrome,
} from "../ui/workspacesTreeFilterState.js";
import { promptFolderIntakeAfterAttach } from "../ui/folderIntakePrompt.js";
import type { WorkspacesTreeProvider, SyncTreeElement } from "../ui/workspacesTree.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";
import { summarisePushForToast } from "../core/bulkPushWizard.js";

export interface WorkspaceTreeContextCommandsDeps {
  context: vscode.ExtensionContext;
  treeView: vscode.TreeView<SyncTreeElement>;
  workspacesTree: WorkspacesTreeProvider;
  syncPreviewChannel: vscode.OutputChannel;
  runWithEngine: RunWithEngineFn;
}

export function registerWorkspaceTreeContextCommands(
  deps: WorkspaceTreeContextCommandsDeps,
): vscode.Disposable[] {
  const { context, treeView, workspacesTree, syncPreviewChannel, runWithEngine } = deps;

  return [
    vscode.commands.registerCommand(
      "vscodesync.treeWorkspacePushAll",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        await runWithEngine(async (engine) => {
          const proceed = await confirmTreeWorkspaceBulkSyncIfNeeded(
            engine,
            syncPreviewChannel,
            el.workspaceId,
            el.note || el.workspaceId,
            "push",
          );
          if (!proceed) {
            return;
          }
          const results = await engine.pushAll(el.workspaceId);
          void vscode.window.showInformationMessage(
            summarisePushForToast(`Push workspace (${el.note})`, results),
          );
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspacePullAll",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        await runWithEngine(async (engine) => {
          const proceed = await confirmTreeWorkspaceBulkSyncIfNeeded(
            engine,
            syncPreviewChannel,
            el.workspaceId,
            el.note || el.workspaceId,
            "pull",
          );
          if (!proceed) {
            return;
          }
          await engine.pullAll(el.workspaceId);
          void vscode.window.showInformationMessage(`Pull workspace (${el.note}): готово.`);
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceSync",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        await runWithEngine(async (engine) => {
          const proceed = await confirmTreeWorkspaceBulkSyncIfNeeded(
            engine,
            syncPreviewChannel,
            el.workspaceId,
            el.note || el.workspaceId,
            "sync",
          );
          if (!proceed) {
            return;
          }
          await engine.syncWorkspace(el.workspaceId);
          void vscode.window.showInformationMessage(`Sync (${el.note}): готово.`);
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceDetach",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        const ws = el.workspaceId;
        const confirm = await vscode.window.showWarningMessage(
          `Отключить «${el.note || ws}» только в этом проекте? Данные в облаке не удаляются.`,
          { modal: true },
          "Отключить",
        );
        if (confirm !== "Отключить") {
          return;
        }
        await runWithEngine(
          async (engine) => {
            await engine.detachWorkspaceLocal(ws);
            void vscode.window.showInformationMessage("Workspace отключён локально.");
          },
          rootPath,
        );
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceRenameNote",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const note =
          (await vscode.window.showInputBox({
            title: "VSCodeSync: имя workspace",
            value: el.note || el.workspaceId,
            validateInput: (v) => (v.trim() ? undefined : "Укажите непустое имя"),
          })) ?? "";
        if (!note.trim()) {
          return;
        }
        await runWithEngine(async (engine) => {
          await engine.renameWorkspaceNote(el.workspaceId, note.trim());
          void vscode.window.showInformationMessage("Название обновлено в облаке и локально.");
        }, el.folderRoot.fsPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceHealthCheck",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const rootPath = el.folderRoot.fsPath;
        const wc = await WorkspaceConfigManager.load(rootPath);
        const local = workspaceHealthFromLocalCfg(wc, el.workspaceId);
        await runWithEngine(async (engine) => {
          const r = await engine.healthCheckWorkspace(el.workspaceId);
          const cloudPart = r.ok ? "манифест OK" : `манифест: ${r.message}`;
          const lines: string[] = [
            "VSCodeSync Health Check",
            "",
            `${workspaceHealthEmoji(local.level)} ${el.note || el.workspaceId} — ${cloudPart}`,
          ];
          for (const s of local.summaryLines) {
            lines.push(`  · ${s}`);
          }
          void vscode.window.showInformationMessage(lines.join("\n"));
        }, rootPath);
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeRemoteWorkspaceConnect",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "remoteOffer") {
          return;
        }
        workspacesTree.setWorkspaceLoading(el.workspaceId, true);
        workspacesTree.refresh();
        try {
          await runWithEngine(async (engine) => {
            const label = el.workspaceNote.trim().length > 0 ? el.workspaceNote : el.workspaceId;
            // Intake prompt BEFORE the initial adopt/pull — the placement rules
            // it writes must govern where the existing files land.
            await engine.attachCloudWorkspace(el.workspaceId, {
              beforeInitialAdopt: () =>
                promptFolderIntakeAfterAttach(
                  runWithEngine,
                  el.anchorFolder.fsPath,
                  el.workspaceId,
                  label,
                ).then(() => undefined),
            });
            void vscode.window.showInformationMessage(
              `VSCodeSync: подключён workspace «${label}» (${el.workspaceId})`,
            );
          }, el.anchorFolder.fsPath);
          workspacesTree.invalidateRemoteCache();
          void (async () => {
            const { maybePromptPathMapperAfterAttach } = await import("../ui/aiPathMapperCommand.js");
            await maybePromptPathMapperAfterAttach(context, el.workspaceId);
          })();
        } finally {
          workspacesTree.setWorkspaceLoading(el.workspaceId, false);
        }
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeRemoteWorkspaceDelete",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "remoteOffer") {
          return;
        }
        const label = el.workspaceNote.trim().length > 0 ? el.workspaceNote : el.workspaceId;
        const confirmed = await vscode.window.showWarningMessage(
          `Удалить workspace «${label}» (${el.workspaceId}) с облака?\n\nВсе файлы в VSCodeSyncFiles/${el.workspaceId}/ будут удалены без восстановления.`,
          { modal: true },
          "Удалить с облака",
        );
        if (confirmed !== "Удалить с облака") {
          return;
        }
        try {
          await runWithEngine(
            async (engine) => {
              await engine.deleteCloudFilesOnly(el.workspaceId);
            },
            el.anchorFolder.fsPath,
            { showErrorDialog: false },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await vscode.window.showErrorMessage(
            `VSCodeSync: не удалось удалить workspace «${label}» с облака. Ошибка: ${msg}`,
          );
          return;
        }
        workspacesTree.invalidateRemoteCache();
        workspacesTree.refresh();
        void vscode.window.showInformationMessage(
          `VSCodeSync: workspace «${label}» (${el.workspaceId}) удалён с облака.`,
        );
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceShowMenu",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const isActive = !el.syncState || el.syncState === "active";
        const isSuspended = el.syncState === "suspended";
        const isFrozen = el.syncState === "frozen";
        const isArchived = el.tags.some((t) => t.trim().toLowerCase() === "archived");

        type MenuItem = vscode.QuickPickItem & { cmd: string; args?: unknown[] };
        const items: MenuItem[] = [];

        if (isActive) {
          items.push(
            { label: "$(cloud-upload) Push All", description: "Залить все файлы на облако", cmd: "vscodesync.treeWorkspacePushAll", args: [el] },
            { label: "$(cloud-download) Pull All", description: "Скачать все файлы с облака", cmd: "vscodesync.treeWorkspacePullAll", args: [el] },
            { label: "$(sync) Sync", description: "Push + Pull", cmd: "vscodesync.treeWorkspaceSync", args: [el] },
            { label: "", kind: vscode.QuickPickItemKind.Separator, cmd: "" },
          );
        }

        items.push(
          { label: "$(edit) Переименовать", description: "Изменить заметку", cmd: "vscodesync.treeWorkspaceRenameNote", args: [el] },
        );

        if (isActive && !isArchived) {
          items.push({ label: "$(archive) Архивировать", description: "Пометить тегом archived", cmd: "vscodesync.archiveWorkspace", args: [el] });
        }
        if (isArchived) {
          items.push({ label: "$(archive) Разархивировать", description: "Убрать тег archived", cmd: "vscodesync.unarchiveWorkspace", args: [el] });
        }
        if (isActive) {
          items.push({ label: "$(debug-pause) Приостановить", description: "Suspend — без push/pull", cmd: "vscodesync.suspendWorkspace", args: [el] });
        }
        if (isSuspended) {
          items.push({ label: "$(play) Возобновить", description: "Resume из Suspend", cmd: "vscodesync.resumeWorkspace", args: [el] });
        }
        if (isActive || isSuspended) {
          items.push({ label: "$(lock) Заморозить", description: "Freeze — только чтение облака", cmd: "vscodesync.freezeWorkspace", args: [el] });
        }
        if (isFrozen) {
          items.push({ label: "$(unlock) Разморозить", description: "Unfreeze", cmd: "vscodesync.unfreezeWorkspace", args: [el] });
        }

        items.push(
          { label: "", kind: vscode.QuickPickItemKind.Separator, cmd: "" },
          { label: "$(pulse) Health Check", description: "Проверить состояние", cmd: "vscodesync.treeWorkspaceHealthCheck", args: [el] },
          { label: "$(plug) Отвязать локально", description: "Detach — облако не трогать", cmd: "vscodesync.treeWorkspaceDetach", args: [el] },
          { label: "", kind: vscode.QuickPickItemKind.Separator, cmd: "" },
          { label: "$(trash) Удалить с облака", description: "Удалить workspace из облака без восстановления", cmd: "vscodesync.deleteWorkspaceFromCloud", args: [el] },
        );

        const picked = await vscode.window.showQuickPick(
          items.filter((i) => i.cmd !== "" || i.kind === vscode.QuickPickItemKind.Separator),
          { title: `Workspace: ${el.note || el.workspaceId}`, placeHolder: "Выберите действие" },
        );
        if (!picked?.cmd) {
          return;
        }
        await vscode.commands.executeCommand(picked.cmd, ...(picked.args ?? []));
      },
    ),

    vscode.commands.registerCommand(
      "vscodesync.treeWorkspaceAddTagToPanelFilter",
      async (el: SyncTreeElement | undefined) => {
        if (el?.kind !== "workspace") {
          return;
        }
        const tags = el.tags;
        if (tags.length === 0) {
          void vscode.window.showInformationMessage(
            "VSCodeSync: у workspace нет тегов в локальном кэше — sync или Repair State.",
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(tags, {
          title: "Добавить тег к фильтру панели (AND)",
        });
        if (!picked) {
          return;
        }
        const next = [...workspacesTree.getTagFilters()];
        const low = picked.trim().toLowerCase();
        if (!next.some((t) => t.trim().toLowerCase() === low)) {
          next.push(picked);
        }
        workspacesTree.setTagFilters(next);
        await context.globalState.update(WORKSPACES_TAG_FILTERS_KEY, [...workspacesTree.getTagFilters()]);
        await applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
      },
    ),
  ];
}
