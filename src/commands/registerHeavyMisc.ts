/**
 * Heavy-misc command bundle — 13th tranche of the `extension.ts`
 * decomposition (v2.6.5 tail).
 *
 * Holds 4 palette commands that have moderate-but-bounded deps surface
 * but were previously stuck in `extension.ts` for one reason each:
 *   - setGitBranchWorkspace: needs `gitBranchActivationDeps` (engine
 *     factory closure) + `listGitBranches` + `applyBranchPolicyForRoot`.
 *   - repairState: pure runWithEngine but multi-mode QuickPick.
 *   - previewSync: runWithEngine + `syncPreviewChannel` OutputChannel
 *     + `writeSyncPreviewOutput`.
 *   - startOnboarding: needs `onboardingCloudDeps`.
 *
 * Same contract as the prior bundles. The 8 truly heavy commands left
 * in `extension.ts` (createWorkspace, connectCloudWorkspace,
 * takeSyncOwnership, healthCheck) all have UNIQUE deps surfaces (lock
 * helpers / health report builder / template add flow) that don't
 * justify a shared bundle.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { listGitBranches } from "../utils/gitBranches.js";
import {
  applyBranchPolicyForRoot,
  type GitBranchAutoActivationDeps,
} from "../ui/gitBranchWorkspaceActivation.js";
import { writeSyncPreviewOutput } from "../ui/syncPreviewUi.js";
import { runOnboardingWizard, type OnboardingCloudDeps } from "../ui/onboarding.js";
import type { SyncStatusBarController } from "../ui/statusBar.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";
import { pickRoot, pickWorkspaceId } from "./_shared.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface HeavyMiscCommandsDeps {
  globalConfig: GlobalConfigManager;
  workspacesTree: WorkspacesTreeProvider;
  statusBar: SyncStatusBarController;
  syncPreviewChannel: vscode.OutputChannel;
  runWithEngine: RunWithEngineFn;
  onboardingCloudDeps: OnboardingCloudDeps;
  gitBranchActivationDeps: GitBranchAutoActivationDeps;
}

export function registerHeavyMiscCommands(deps: HeavyMiscCommandsDeps): vscode.Disposable[] {
  const {
    globalConfig,
    workspacesTree,
    statusBar,
    syncPreviewChannel,
    runWithEngine,
    onboardingCloudDeps,
    gitBranchActivationDeps,
  } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.setGitBranchWorkspace", async () => {
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
        const current = fields === undefined ? "" : (fields.gitBranch ?? "");
        const branches = await listGitBranches(root);
        type BranchPick = vscode.QuickPickItem & { mode: "clear" | "branch" | "manual" };
        const items: BranchPick[] = [
          { label: "— Очистить привязку —", description: "Workspace всегда активен", mode: "clear" },
          ...branches.map((b) => ({ label: b, mode: "branch" as const })),
          { label: "Другая ветка…", description: "Ввод вручную", mode: "manual" },
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Текущая привязка: ${current || "нет"}`,
          title: "VSCodeSync: git branch для workspace",
        });
        if (!picked) {
          return;
        }
        let branch = "";
        if (picked.mode === "clear") {
          branch = "";
        } else if (picked.mode === "manual") {
          const manual =
            (await vscode.window.showInputBox({
              title: "VSCodeSync: имя ветки",
              prompt: "Как в git (например main или feature/auth)",
              value: current,
            })) ?? undefined;
          if (manual === undefined) {
            return;
          }
          branch = manual.trim();
        } else {
          branch = picked.label.trim();
        }
        await engine.setWorkspaceGitBranch(ws, branch);
        void applyBranchPolicyForRoot(root, gitBranchActivationDeps);
        await vscode.window.showInformationMessage(
          branch === ""
            ? "VSCodeSync: привязка git branch снята; workspace всегда активен."
            : "VSCodeSync: gitBranch записан в облачный манифест и кэш локально.",
        );
      });
    }),

    vscode.commands.registerCommand("vscodesync.repairState", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace для repair.");
        return;
      }

      const mode = await vscode.window.showQuickPick(
        [
          {
            label: "$(sync) Обычный ремонт",
            description: "Обновить ETag, имя, провайдер из манифеста (быстро)",
            value: "normal" as const,
          },
          {
            label: "$(search) Полный ремонт (сканирование облака)",
            description: "Восстановить _meta.json из структуры папок на облаке — для повреждённых/пустых манифестов",
            value: "scan" as const,
          },
        ],
        { placeHolder: "Режим ремонта" },
      );
      if (!mode) return;

      if (mode.value === "normal") {
        await runWithEngine(async (engine) => {
          await engine.repairLocalStateFromCloud();
          await vscode.window.showInformationMessage(
            "VSCodeSync Repair: ETag манифеста и _meta, имя workspace подтянуты с облака.",
          );
        });
        return;
      }

      type WsPick = vscode.QuickPickItem & { workspaceId: string };
      const items: WsPick[] = wc.activeWorkspaces.map((w) => ({
        label: w.workspaceNote || w.workspaceId,
        description: w.workspaceId,
        workspaceId: w.workspaceId,
      }));
      const pick = await vscode.window.showQuickPick<WsPick>(items, {
        placeHolder: "Выберите workspace для сканирования облака",
      });
      if (!pick) return;

      await runWithEngine(async (engine) => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `VSCodeSync: сканирование облака для «${pick.label}»…`,
            cancellable: false,
          },
          async () => {
            const found = await engine.repairByCloudScan(pick.workspaceId);
            if (found.length === 0) {
              await vscode.window.showInformationMessage(
                `VSCodeSync Repair Scan: в облаке нет файлов для workspace «${pick.label}».`,
              );
              return;
            }
            const doPull = await vscode.window.showInformationMessage(
              `VSCodeSync Repair Scan: найдено ${String(found.length)} файлов в облаке. _meta.json восстановлен. Выполнить Pull для загрузки файлов?`,
              "Pull сейчас",
              "Позже",
            );
            if (doPull === "Pull сейчас") {
              await engine.pullAll(pick.workspaceId);
              await vscode.window.showInformationMessage("VSCodeSync Repair: Pull завершён.");
            }
          },
        );
      });
    }),

    vscode.commands.registerCommand("vscodesync.previewSync", async () => {
      const root = pickRoot();
      if (!root) {
        await vscode.window.showErrorMessage("VSCodeSync: откройте папку.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }
      let scope: string | undefined;
      if (wc.activeWorkspaces.length === 1) {
        scope = wc.activeWorkspaces[0]?.workspaceId;
      } else {
        type WsPick = vscode.QuickPickItem & { wsId?: string };
        const picked = await vscode.window.showQuickPick<WsPick>(
          [
            {
              label: "$(sync) Все активные workspace",
              description: "Сводка по каждому",
              wsId: undefined,
            },
            ...wc.activeWorkspaces.map((w) => ({
              label: w.workspaceNote,
              description: w.workspaceId,
              wsId: w.workspaceId,
            })),
          ],
          { placeHolder: "Preview Sync — для какого workspace" },
        );
        if (!picked) {
          return;
        }
        scope = picked.wsId;
      }
      await runWithEngine(
        async (engine) => {
          const plan = await engine.previewSyncPlan(scope);
          writeSyncPreviewOutput(syncPreviewChannel, plan);
          syncPreviewChannel.show(true);
          const nPush = plan.reduce((acc, w) => acc + w.files.filter((f) => f.action === "push").length, 0);
          const nPull = plan.reduce((acc, w) => acc + w.files.filter((f) => f.action === "pull").length, 0);
          const nConf = plan.reduce(
            (acc, w) => acc + w.files.filter((f) => f.action === "conflict" || f.action === "conflict_pending").length,
            0,
          );
          await vscode.window.showInformationMessage(
            `Preview Sync: push ${String(nPush)} · pull ${String(nPull)} · конфликты ${String(nConf)}. Подробности — панель Output «VSCodeSync · Preview».`,
          );
        },
        undefined,
      );
    }),

    vscode.commands.registerCommand("vscodesync.startOnboarding", async () => {
      await runOnboardingWizard(globalConfig, onboardingCloudDeps);
      await statusBar.refresh();
      workspacesTree.refresh();
    }),
  ];
}
