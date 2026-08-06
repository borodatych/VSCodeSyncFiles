/**
 * Workspaces tree view-management command bundle — fifth tranche of the
 * `extension.ts` decomposition (v2.6 in the roadmap).
 *
 * Holds the 8 commands that interact with the Workspaces TreeView chrome
 * (collapse / refresh / filter inputbox / tag QuickPick / show-archived
 * toggle / focus / dashboard).
 *
 * Same contract as `registerWorkspaceLifecycle.ts`:
 *   - All deps come in via `ViewManagementCommandsDeps`.
 *   - The mutable `workspacesFilterInputBox` is encapsulated here as
 *     module-private state.
 */
import * as vscode from "vscode";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { WorkspacesTreeProvider, SyncTreeElement } from "../ui/workspacesTree.js";
import {
  WORKSPACES_NOTE_FILTER_KEY,
  WORKSPACES_TAG_FILTERS_KEY,
  WORKSPACES_SHOW_ARCHIVED_KEY,
  applyWorkspacesTreeFilterChrome,
  collectAllWorkspaceTags,
} from "../ui/workspacesTreeFilterState.js";

export interface ViewManagementCommandsDeps {
  context: vscode.ExtensionContext;
  treeView: vscode.TreeView<SyncTreeElement>;
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
}

let workspacesFilterInputBox: vscode.InputBox | undefined;

export function registerViewManagementCommands(
  deps: ViewManagementCommandsDeps,
): vscode.Disposable[] {
  const { context, treeView, workspacesTree, statusBar } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.collapseAllWorkspaces", () => {
      // `collapseAll` exists at runtime but is missing from older @types/vscode.
      const v = treeView as unknown as { collapseAll?: () => Thenable<void> };
      void v.collapseAll?.();
    }),

    /**
     * One palette entry for the visual panels (F12). Six separate "show…" /
     * "open…" commands are six things to remember; the panels themselves are
     * unchanged and still reachable by id from the Command Center.
     */
    vscode.commands.registerCommand("vscodesync.openDashboard", async () => {
      type Pick = vscode.QuickPickItem & { cmd: string };
      const items: Pick[] = [
        { label: "$(dashboard) Дашборд синхронизации", cmd: "vscodesync.showSyncDashboard" },
        { label: "$(pulse) Лента активности", cmd: "vscodesync.openActivityFeed" },
        { label: "$(flame) Тепловая карта конфликтов", cmd: "vscodesync.showConflictHeatmap" },
        { label: "$(circuit-board) Граф машин", cmd: "vscodesync.openMachinesGraph" },
        { label: "$(graph) Аналитика", cmd: "vscodesync.openAnalyticsPanel" },
        { label: "$(gear) Настройки", cmd: "vscodesync.showSettingsPanel" },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: "VSCodeSync: панели",
        placeHolder: "Что открыть",
      });
      if (picked) {
        await vscode.commands.executeCommand(picked.cmd);
      }
    }),

    vscode.commands.registerCommand("vscodesync.showSyncDashboard", async () => {
      await statusBar.showDashboard();
    }),

    vscode.commands.registerCommand("vscodesync.focusWorkspacesView", async () => {
      try {
        await vscode.commands.executeCommand("vscodesync.workspaces.focus");
      } catch (err) {
        console.warn("[vscodesync] focusWorkspacesView failed:", err);
      }
    }),

    vscode.commands.registerCommand("vscodesync.refreshWorkspacesView", () => {
      workspacesTree.invalidateRemoteCache();
      workspacesTree.refresh();
    }),

    vscode.commands.registerCommand("vscodesync.filterWorkspaces", () => {
      if (workspacesFilterInputBox) {
        workspacesFilterInputBox.show();
        return;
      }
      const ib = vscode.window.createInputBox();
      workspacesFilterInputBox = ib;
      ib.title = "VSCodeSync: фильтр Workspaces";
      ib.placeholder = "По заметке или ID workspace";
      ib.value = workspacesTree.getNoteFilter();
      let debounce: ReturnType<typeof setTimeout> | undefined;
      ib.onDidChangeValue((v) => {
        if (debounce !== undefined) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
          debounce = undefined;
          const trimmed = v.trim();
          workspacesTree.setNoteFilter(v);
          void context.globalState.update(WORKSPACES_NOTE_FILTER_KEY, trimmed);
          void applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
        }, 120);
      });
      ib.onDidAccept(() => {
        ib.hide();
      });
      ib.onDidHide(() => {
        if (debounce !== undefined) {
          clearTimeout(debounce);
        }
        workspacesFilterInputBox = undefined;
        ib.dispose();
      });
      ib.show();
    }),

    vscode.commands.registerCommand("vscodesync.clearWorkspacesFilter", async () => {
      workspacesTree.setNoteFilter("");
      workspacesTree.setTagFilters([]);
      await context.globalState.update(WORKSPACES_NOTE_FILTER_KEY, "");
      await context.globalState.update(WORKSPACES_TAG_FILTERS_KEY, []);
      await applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
    }),

    vscode.commands.registerCommand("vscodesync.pickWorkspaceTagFilters", async () => {
      const allTags = await collectAllWorkspaceTags();
      if (allTags.length === 0) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: в локальном кэше нет тегов. Выполните sync / Repair State или задайте теги для workspace.",
        );
        return;
      }
      const current = new Set(workspacesTree.getTagFilters().map((t) => t.trim().toLowerCase()));
      const picked = await vscode.window.showQuickPick(
        allTags.map((label) => ({ label, picked: current.has(label.trim().toLowerCase()) })),
        { canPickMany: true, title: "VSCodeSync: фильтр тегов (все выбранные — AND)" },
      );
      if (picked === undefined) {
        return;
      }
      workspacesTree.setTagFilters(picked.map((p) => p.label));
      await context.globalState.update(WORKSPACES_TAG_FILTERS_KEY, [...workspacesTree.getTagFilters()]);
      await applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
    }),

    vscode.commands.registerCommand("vscodesync.toggleShowArchivedWorkspaces", async () => {
      workspacesTree.setShowArchived(!workspacesTree.getShowArchived());
      await context.globalState.update(WORKSPACES_SHOW_ARCHIVED_KEY, workspacesTree.getShowArchived());
      await applyWorkspacesTreeFilterChrome(treeView, workspacesTree);
    }),
  ];
}
