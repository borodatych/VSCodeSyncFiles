/**
 * v2.6.6 / v2.14.1 — engine-rich smart features bundle.
 *
 * Hosts the 5 commands that pair the AI / insights / snapshot core helpers
 * with vscode UI. Extracted from `plannedPaletteCommands.ts` so the engine
 * surface (globalConfig + tryAuthenticatedProvider) is co-located with the
 * commands that need it.
 *
 *   - vscodesync.aiSessionSummary        — LM-based weekly digest of activity
 *   - vscodesync.aiSuggestWorkspaceTags  — LM-based tag suggestions
 *   - vscodesync.aiPathMapper            — LM-based path remap suggestions
 *   - vscodesync.showInsightsWeeklyDigest — non-AI weekly digest from activity
 *   - vscodesync.diffSnapshots           — interactive workspace snapshot diff
 *
 * Each AI command goes through `ensureAiCommandEnabled` (per-command
 * privacy gate, default off). Each LM-bound command uses `withProgress`
 * with `cancellable: true` and threads the token into the helper.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { resolveWorkspaceRootForPaletteCommand } from "../utils/workspaceRootResolver.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";

const CFG = "vscodesync";

export interface SmartFeaturesEngineDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
}

/**
 * v2.14.2 — privacy gate. Returns `true` when the AI command is allowed to
 * dispatch payload to a language model. When the per-command setting is off
 * (default), shows an info toast with an "Open Settings" action.
 */
async function ensureAiCommandEnabled(settingKey: string, commandTitle: string): Promise<boolean> {
  const enabled = vscode.workspace.getConfiguration(CFG).get<boolean>(settingKey, false);
  if (enabled) return true;
  const fullKey = `${CFG}.${settingKey}`;
  const choice = await vscode.window.showInformationMessage(
    `VSCodeSync: ${commandTitle} отключена в целях приватности. Включите в Settings → ${fullKey}.`,
    "Open Settings",
  );
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", fullKey);
  }
  return false;
}

export function registerSmartFeaturesEngineCommands(
  deps: SmartFeaturesEngineDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vscodesync.aiSessionSummary", async () => {
      if (!(await ensureAiCommandEnabled("ai.sessionSummary.enabled", "AI session summary"))) return;
      const { loadActivityFile } = await import("../core/activityLog.js");
      const { summariseActivity } = await import("../core/aiSessionSummary.js");
      const dir = deps.globalConfig.getStorageDir();
      const data = await loadActivityFile(dir);
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Сегодня", windowMs: 24 * 3600_000, description: "за последние 24 часа" },
          { label: "Эта неделя", windowMs: 7 * 24 * 3600_000, description: "за последние 7 дней" },
          { label: "Этот месяц", windowMs: 30 * 24 * 3600_000, description: "за последние 30 дней" },
        ],
        { placeHolder: "Окно для AI-сводки" },
      );
      if (!pick) return;
      const cutoff = Date.now() - pick.windowMs;
      const filtered = data.events.filter((e) => Date.parse(e.at) >= cutoff);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: AI summary…", cancellable: true },
        async (_p, token) => {
          const result = await summariseActivity(filtered, pick.label, token);
          if (!result.ok) {
            const msg =
              result.reason === "no_events"
                ? "Нет событий в выбранном окне."
                : result.reason === "no_model"
                  ? "Нет доступной языковой модели (нужен Copilot или совместимый LM provider в VS Code)."
                  : `AI summary error: ${result.detail ?? "unknown"}`;
            await vscode.window.showWarningMessage(`VSCodeSync: ${msg}`);
            return;
          }
          const ch = vscode.window.createOutputChannel(`VSCodeSync · AI summary · ${pick.label}`);
          ch.appendLine(`AI summary (${pick.label}):`);
          ch.appendLine("");
          ch.appendLine(result.summary);
          ch.show();
        },
      );
    }),

    vscode.commands.registerCommand("vscodesync.aiSuggestWorkspaceTags", async () => {
      if (!(await ensureAiCommandEnabled("ai.suggestWorkspaceTags.enabled", "AI suggest workspace tags"))) return;
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
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
          { placeHolder: "Workspace для тегов" },
        );
        workspaceId = picked?.id;
      }
      if (!workspaceId) return;
      const ws = workspaceId;
      const files = wc.files.filter((f) => f.workspaceId === ws).map((f) => f.localPath);
      if (files.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: в workspace нет файлов для анализа.");
        return;
      }
      const { suggestWorkspaceTags } = await import("../core/aiSessionSummary.js");
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: AI tagger…", cancellable: true },
        async (_p, token) => {
          const result = await suggestWorkspaceTags(files, token);
          if (!result.ok) {
            await vscode.window.showWarningMessage(
              "VSCodeSync: AI tagger недоступен или не дал валидных тегов.",
            );
            return;
          }
          const accepted = await vscode.window.showInformationMessage(
            `VSCodeSync AI tagger предложил: ${result.tags.join(", ")}. Применить?`,
            "Применить",
            "Отмена",
          );
          if (accepted !== "Применить") return;
          await vscode.commands.executeCommand("vscodesync.editWorkspaceTags", ws, result.tags);
        },
      );
    }),

    vscode.commands.registerCommand("vscodesync.aiPathMapper", async () => {
      if (!(await ensureAiCommandEnabled("ai.pathMapper.enabled", "AI path mapper"))) return;
      const { runAiPathMapper } = await import("../ui/aiPathMapperCommand.js");
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: AI path mapper…", cancellable: true },
        async (_p, token) => {
          await runAiPathMapper(token);
        },
      );
    }),

    vscode.commands.registerCommand("vscodesync.showInsightsWeeklyDigest", async () => {
      const { loadActivityFile } = await import("../core/activityLog.js");
      const { buildWeeklyDigest, formatWeeklyDigest } = await import(
        "../core/insightsWeeklyDigest.js"
      );
      const file = await loadActivityFile(deps.globalConfig.getStorageDir());
      const digest = buildWeeklyDigest({ events: file.events, nowMs: Date.now() });
      const channel = vscode.window.createOutputChannel("VSCodeSync · insights");
      channel.clear();
      channel.appendLine(formatWeeklyDigest(digest));
      channel.show(true);
    }),

    vscode.commands.registerCommand("vscodesync.diffSnapshots", async () => {
      const provider = await deps.tryAuthenticatedProvider();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
        return;
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showInformationMessage("VSCodeSync: нет активных workspace в этой папке.");
        return;
      }
      const wsPick = await vscode.window.showQuickPick(
        wc.activeWorkspaces.map((w) => ({
          label: w.workspaceNote || w.workspaceId,
          description: w.workspaceId.slice(0, 8),
          workspaceId: w.workspaceId,
        })),
        { title: "Snapshot diff — workspace", placeHolder: "Выберите workspace" },
      );
      if (!wsPick) return;
      const { runSnapshotDiff } = await import("../ui/snapshotDiffCommand.js");
      await runSnapshotDiff({
        getProvider: () => Promise.resolve(provider),
        pickWorkspaceId: () => Promise.resolve(wsPick.workspaceId),
      });
    }),
  ];
}
