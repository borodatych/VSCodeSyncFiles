import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import { resolveWorkspaceRootForPaletteCommand } from "../utils/workspaceRootResolver.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";

export interface MergeWorkspacesDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider?: () => Promise<ICloudProvider | null>;
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
  refreshAfterLocalConfigChange?: () => void | Promise<void>;
}

interface MergeWsQuickPickRow {
  label: string;
  description: string;
  wsId: string;
}

/**
 * Palette: `VSCodeSync: Merge Workspaces` — см. docs/v1/06-power-features/roadmap.md §6.7.
 */
export async function runMergeWorkspaces(deps: MergeWorkspacesDeps): Promise<void> {
  if (!(await assertWorkspaceTrusted())) {
    return;
  }
  const root = await resolveWorkspaceRootForPaletteCommand();
  if (!root) {
    await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
    return;
  }
  const wc = await WorkspaceConfigManager.load(root);
  if (wc.activeWorkspaces.length < 2) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: нужно минимум два активных workspace в этом проекте.",
    );
    return;
  }

  const items: MergeWsQuickPickRow[] = wc.activeWorkspaces.map((w) => ({
    label: w.workspaceNote || w.workspaceId,
    description: w.workspaceId,
    wsId: w.workspaceId,
  }));

  const pickedSource = await vscode.window.showQuickPick(items, {
    placeHolder: "Источник — откуда переносятся файлы в облаке",
  });
  if (!pickedSource) {
    return;
  }

  const targetCandidates = items.filter((i) => i.wsId !== pickedSource.wsId);
  const pickedTarget = await vscode.window.showQuickPick(targetCandidates, {
    placeHolder: "Цель — workspace, куда добавляются файлы",
  });
  if (!pickedTarget) {
    return;
  }

  const pickedDelete = await vscode.window.showQuickPick(
    [
      {
        label: "$(trash) Удалить источник на облаке после merge",
        description: "Удаляется вся папка VSCodeSyncFiles/{id}",
        value: true as const,
      },
      {
        label: "$(folder) Оставить пустую оболочку источника на облаке",
        description: "Файлы удаляются, manifest пустой",
        value: false as const,
      },
    ],
    { placeHolder: "Что сделать с workspace-источником на облаке после merge" },
  );
  if (!pickedDelete) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    [
      `Объединить «${pickedSource.label}» → «${pickedTarget.label}»?`,
      "Перед операцией создаются снапшоты auto-pre-merge-<дата> для обоих workspace.",
      "Если один и тот же относительный путь есть в обоих — merge будет отклонён.",
    ].join("\n"),
    { modal: true },
    "Объединить",
  );
  if (confirm !== "Объединить") {
    return;
  }

  const provider = await deps.tryAuthenticatedProvider?.();
  if (!provider) {
    await vscode.window.showWarningMessage("VSCodeSync: провайдер не авторизован.");
    return;
  }
  const gc = await deps.globalConfig.load();
  const engine = deps.makeEngine(root, provider, gc.machineId, gc.machineName, "user");

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "VSCodeSync: Merge Workspaces…",
        cancellable: false,
      },
      async () => {
        await engine.mergeWorkspaces(pickedSource.wsId, pickedTarget.wsId, {
          deleteSourceWorkspace: pickedDelete.value,
        });
      },
    );
    void vscode.window.showInformationMessage("VSCodeSync: workspace объединены.");
    await deps.refreshAfterLocalConfigChange?.();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(`VSCodeSync Merge: ${msg}`);
  }
}
