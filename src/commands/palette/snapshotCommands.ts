/**
 * Workspace snapshots — palette commands.
 *
 * Снапшоты воркспейса: создание и восстановление (с авто-снапшотом перед восстановлением).
 *
 * Вынесено из `ui/plannedPaletteCommands.ts` (F12): 27 команд из семи доменов
 * жили в одном файле на 1115 строк, и добавление любой новой команды делало
 * его ещё менее читаемым.
 */
import * as vscode from "vscode";
import { assertWorkspaceTrusted } from "../../ui/workspaceTrust.js";
import {
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
} from "../../core/snapshotsEngine.js";
import { planSnapshotRetention } from "../../core/snapshotRetentionPlan.js";
import { resolveWorkspaceRootForPaletteCommand } from "../../utils/workspaceRootResolver.js";
import type { PaletteExtras } from "./_shared.js";
import { CFG, requireSnapshotCrypto } from "./_shared.js";

export function registerSnapshotCommands(
  context: vscode.ExtensionContext,
  extras: PaletteExtras,
): void {
  const configuration = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(CFG);

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.createSnapshot", async () => {
      if (!(await assertWorkspaceTrusted())) {
        return;
      }
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
        return;
      }
      const gc = await extras.globalConfig.load();
      const { WorkspaceConfigManager: WCM } = await import("../../core/workspaceConfigManager.js");
      const wc = await WCM.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }

      let workspaceId: string | undefined;
      if (wc.activeWorkspaces.length === 1) {
        workspaceId = wc.activeWorkspaces[0]?.workspaceId;
      } else {
        const picked = await vscode.window.showQuickPick(
          wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, id: w.workspaceId })),
          { placeHolder: "Workspace для снапшота" },
        );
        workspaceId = picked?.id;
      }
      if (!workspaceId) {
        return;
      }

      // AI prefill (best-effort): if vscode.lm is available and aiMerge is on,
      // suggest a Conventional-Commit one-liner from the workspace's tracked files.
      // Falls back to empty placeholder when LM isn't available.
      let aiPrefill = "";
      const aiOn = configuration().get<boolean>("aiMerge.enabled", false);
      if (aiOn) {
        try {
          const targetWs = wc.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
          const files = wc.files
            .filter((f) => f.workspaceId === workspaceId)
            .map((f) => f.localPath);
          const { suggestCommitMessage } = await import("../../ui/ai/aiCommitMessage.js");
          const suggestion = await suggestCommitMessage({
            workspaceNote: targetWs?.workspaceNote ?? "",
            changedFiles: files,
            intent: "snapshot",
          });
          if (suggestion.ok) aiPrefill = suggestion.message;
        } catch {
          /* AI is opt-in; ignore failures silently */
        }
      }

      const nameInput = await vscode.window.showInputBox({
        prompt: "Имя снапшота (например: перед деплоем)",
        placeHolder: "snapshot-name",
        value: aiPrefill,
      });
      if (!nameInput?.trim()) {
        return;
      }

      const snapCrypto = await requireSnapshotCrypto(extras.secrets);
      if (snapCrypto === null) return;
      const wsId = workspaceId;
      const conf = configuration();
      const retentionDays = conf.get<number>("snapshotRetentionDays", 180);
      const maxPerWorkspace = conf.get<number>("maxSnapshotsPerWorkspace", 20);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: создание снапшота…", cancellable: false },
        async () => {
          const finalName = await createWorkspaceSnapshot(
            provider,
            root,
            wsId,
            nameInput,
            gc.machineName,
            snapCrypto,
          );
          void vscode.window.showInformationMessage(`VSCodeSync: снапшот «${finalName}» создан.`);
          try {
            const snapshots = await listWorkspaceSnapshots(provider, wsId);
            const plan = planSnapshotRetention({ snapshots, retentionDays, maxPerWorkspace });
            for (const s of plan.delete) {
              await deleteWorkspaceSnapshot(provider, wsId, s.name);
            }
          } catch {
            /* retention is best-effort — never fail the create itself */
          }
        },
      );
    }),

    vscode.commands.registerCommand("vscodesync.restoreSnapshot", async () => {
      if (!(await assertWorkspaceTrusted())) {
        return;
      }
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
        return;
      }
      const gc = await extras.globalConfig.load();
      const { WorkspaceConfigManager: WCM } = await import("../../core/workspaceConfigManager.js");
      const wc = await WCM.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }

      let workspaceId: string | undefined;
      if (wc.activeWorkspaces.length === 1) {
        workspaceId = wc.activeWorkspaces[0]?.workspaceId;
      } else {
        const picked = await vscode.window.showQuickPick(
          wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, id: w.workspaceId })),
          { placeHolder: "Workspace для восстановления" },
        );
        workspaceId = picked?.id;
      }
      if (!workspaceId) {
        return;
      }

      const snapshots = await listWorkspaceSnapshots(provider, workspaceId);
      if (snapshots.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: снапшотов не найдено.");
        return;
      }

      const items = snapshots.map((s) => ({
        label: s.meta.name,
        description: `${s.category === "system" ? "🔒 Системный" : "Пользовательский"} · ${new Date(s.meta.createdAt).toLocaleString(vscode.env.language)} · ${String(s.meta.files.length)} файлов`,
        name: s.name,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Выберите снапшот для восстановления",
      });
      if (!picked) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Восстановить снапшот «${picked.label}»? Перед восстановлением будет создан авто-снапшот. Текущие локальные файлы будут перезаписаны.`,
        { modal: true },
        "Восстановить",
      );
      if (confirm !== "Восстановить") {
        return;
      }

      const restoreCrypto = await requireSnapshotCrypto(extras.secrets);
      if (restoreCrypto === null) return;
      const wsIdRestore = workspaceId;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: восстановление снапшота…", cancellable: false },
        async (progress) => {
          progress.report({ message: "Создание авто-снапшота…" });
          await createWorkspaceSnapshot(
            provider,
            root,
            wsIdRestore,
            `auto-pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`,
            gc.machineName,
            restoreCrypto,
          );
          progress.report({ message: "Восстановление файлов…" });
          const result = await restoreWorkspaceSnapshot(
            provider,
            root,
            wsIdRestore,
            picked.name,
            gc.machineName,
            restoreCrypto,
          );
          void vscode.window.showInformationMessage(
            `VSCodeSync: восстановлено ${String(result.restoredCount)} файлов из снапшота «${picked.label}».`,
          );
        },
      );
    }),
  );
}
