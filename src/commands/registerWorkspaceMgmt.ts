/**
 * Workspace-management palette command bundle — twelfth tranche of the
 * `extension.ts` decomposition (v2.6 in the roadmap).
 *
 * Holds 5 commands that perform light workspace-level actions from the
 * palette: quick switch, detach, rename, edit tags, and share-link copy.
 * Heavier commands (create / connect / setGitBranch / healthCheck /
 * repairState / previewSync / startOnboarding) stay in extension.ts —
 * they pull in many activate-scope helpers (template engine,
 * buildHealthCheckReport, OAuth flows) that aren't worth the deps
 * surface to forward.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import { pickRoot, pickWorkspaceId } from "./_shared.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface WorkspaceMgmtCommandsDeps {
  globalConfig: GlobalConfigManager;
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
  runWithEngine: RunWithEngineFn;
}

export function registerWorkspaceMgmtCommands(
  deps: WorkspaceMgmtCommandsDeps,
): vscode.Disposable[] {
  const { globalConfig, runWithEngine } = deps;
  void deps.workspacesTree;
  void deps.statusBar;

  return [
    vscode.commands.registerCommand("vscodesync.quickSwitchWorkspace", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      type Item = vscode.QuickPickItem & {
        folder: vscode.WorkspaceFolder;
        workspaceId: string;
        suspended: boolean;
        lastSync: string;
      };
      const items: Item[] = [];
      for (const folder of folders) {
        const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
        for (const aw of wc.activeWorkspaces) {
          const filesForWs = wc.files.filter((f) => f.workspaceId === aw.workspaceId);
          let last = "";
          for (const f of filesForWs) {
            if (f.lastSync && f.lastSync > last) last = f.lastSync;
          }
          const note = aw.workspaceNote || aw.workspaceId;
          const suspended = normalizeWorkspaceSyncState(aw) === "suspended";
          const icon = suspended ? "$(debug-pause)" : "$(cloud)";
          items.push({
            folder,
            workspaceId: aw.workspaceId,
            suspended,
            lastSync: last,
            label: `${icon} ${note}`,
            description: suspended ? "suspended" : "active",
            detail: `${folder.name} · ${String(filesForWs.length)} files${last ? ` · last sync ${last}` : ""}`,
          });
        }
      }
      if (items.length === 0) {
        await vscode.window.showInformationMessage(
          "VSCodeSync: в открытых папках нет подключённых workspace.",
        );
        return;
      }
      items.sort((a, b) => (a.lastSync < b.lastSync ? 1 : a.lastSync > b.lastSync ? -1 : 0));
      const picked = await vscode.window.showQuickPick(items, {
        title: "VSCodeSync · быстрое переключение workspace",
        placeHolder: "Выберите workspace для просмотра / Resume / Suspend",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) return;
      await vscode.commands.executeCommand("vscodesync.focusWorkspacesView");
      if (picked.suspended) {
        await vscode.window.showInformationMessage(
          `«${picked.label.replace(/^\$\([^)]+\)\s*/, "")}» в режиме Suspend — нажмите Resume в дереве.`,
        );
      }
    }),

    vscode.commands.registerCommand("vscodesync.detachWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("Нет активных workspace.");
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      const aw = wc.activeWorkspaces.find((w) => w.workspaceId === ws);
      const confirm = await vscode.window.showWarningMessage(
        `Отключить «${aw?.workspaceNote ?? ws}» только в этом проекте? Данные в облаке не удаляются.`,
        { modal: true },
        "Отключить",
      );
      if (confirm !== "Отключить") {
        return;
      }
      await runWithEngine(
        async (engine) => {
          await engine.detachWorkspaceLocal(ws);
          await vscode.window.showInformationMessage("Workspace отключён локально.");
        },
        undefined,
      );
    }),

    vscode.commands.registerCommand("vscodesync.renameWorkspaceNote", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      const aw = wc.activeWorkspaces.find((w) => w.workspaceId === ws);
      const note =
        (await vscode.window.showInputBox({
          title: "VSCodeSync: имя workspace",
          value: aw?.workspaceNote ?? ws,
          validateInput: (v) => (v.trim() ? undefined : "Укажите непустое имя"),
        })) ?? "";
      if (!note.trim()) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.renameWorkspaceNote(ws, note.trim());
        await vscode.window.showInformationMessage("Название обновлено в облаке и локально.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.editWorkspaceTags", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(async (engine) => {
        const fields = await engine.getWorkspaceManifestFields(ws);
        const currentTags =
          fields === undefined ? "" : fields.tags.length > 0 ? fields.tags.join(", ") : "";
        const raw = await vscode.window.showInputBox({
          title: "VSCodeSync: теги workspace",
          prompt: "Через запятую; пробелы обрезаются. Пусто — очистить теги",
          value: currentTags,
        });
        if (raw === undefined) {
          return;
        }
        const tags = raw.split(",").map((s) => s.trim());
        await engine.setWorkspaceTags(ws, tags);
        await vscode.window.showInformationMessage("Теги в облачном манифесте обновлены.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.shareWorkspaceLink", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) return;
      const wc = await WorkspaceConfigManager.load(folders[0].uri.fsPath);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace для расшаривания.");
        return;
      }
      const pick = wc.activeWorkspaces.length === 1
        ? wc.activeWorkspaces[0]
        : await vscode.window.showQuickPick(
            wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, description: w.workspaceId, w })),
            { placeHolder: "Workspace для расшаривания" },
          ).then((p) => p?.w);
      if (!pick) return;
      const gc = await globalConfig.load();
      const provider = gc.activeProvider ?? "onedrive";
      const link = `vscode://borodatych.vscodesyncfiles/connect?provider=${encodeURIComponent(provider)}&workspaceId=${encodeURIComponent(pick.workspaceId)}`;
      await vscode.env.clipboard.writeText(link);
      await vscode.window.showInformationMessage(
        `VSCodeSync: link скопирован в буфер обмена. Откройте его на другой машине, чтобы подключить workspace «${pick.workspaceNote}».`,
      );
    }),
  ];
}
