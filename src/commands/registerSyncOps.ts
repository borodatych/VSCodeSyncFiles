/**
 * Sync-operations palette command bundle — eleventh tranche of the
 * `extension.ts` decomposition (v2.6 in the roadmap).
 *
 * Holds the 6 commands that trigger multi-file or workspace-scoped
 * syncs from the palette: pushAll / pullAll across all workspaces,
 * push/pull/sync of one workspace, and the bulkPush wizard with
 * progress notification + per-workspace OutputChannel report.
 */
import * as vscode from "vscode";
import * as os from "node:os";
import * as nodePath from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { pickRoot, pickWorkspaceId } from "./_shared.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";
import { summarisePushForToast } from "../core/bulkPushWizard.js";
import { chooseMissingFilePlacement } from "./_placementFlow.js";

export interface SyncOpsCommandsDeps {
  runWithEngine: RunWithEngineFn;
}

export function registerSyncOpsCommands(deps: SyncOpsCommandsDeps): vscode.Disposable[] {
  const { runWithEngine } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.pushAll", async () => {
      await runWithEngine(
        async (engine) => {
          const results = await engine.pushAll();
          void vscode.window.showInformationMessage(summarisePushForToast("Push all", results));
        },
        undefined,
        { cancellable: "VSCodeSync: отправка всех воркспейсов…" },
      );
    }),

    vscode.commands.registerCommand("vscodesync.bulkPush", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const cfg = await WorkspaceConfigManager.load(root);
      if (cfg.activeWorkspaces.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: нет активных workspace для push.");
        return;
      }
      const { planBulkPush, formatBulkPushResults } = await import("../core/bulkPushWizard.js");
      const targets = cfg.activeWorkspaces.map((w) => {
        const pendingFileCount = cfg.files.filter(
          (f) => f.workspaceId === w.workspaceId && f.syncStatus !== "conflict",
        ).length;
        return {
          workspaceId: w.workspaceId,
          workspaceNote: w.workspaceNote || w.workspaceId,
          pendingFileCount,
        };
      });
      const plan = planBulkPush(targets);
      if (plan.totalWorkspaces === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: нет workspace c файлами для push.");
        return;
      }
      const picks = await vscode.window.showQuickPick(
        plan.targets.map((t) => ({
          label: t.workspaceNote,
          description: `${String(t.pendingFileCount)} файл(ов) · ${t.workspaceId.slice(0, 8)}`,
          picked: true,
          workspaceId: t.workspaceId,
        })),
        {
          canPickMany: true,
          title: `Bulk Push — ${String(plan.totalWorkspaces)} workspace(s), ${String(plan.totalPendingFiles)} файл(ов)`,
          placeHolder: "Выберите workspace'ы для push (Space — toggle, Enter — старт)",
        },
      );
      if (!picks || picks.length === 0) {
        return;
      }
      const selected = new Set(picks.map((p) => p.workspaceId));
      const channel = vscode.window.createOutputChannel("VSCodeSync · Bulk Push");
      channel.clear();
      channel.show(true);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "VSCodeSync · Bulk Push",
          cancellable: false,
        },
        async (progress) => {
          await runWithEngine(async (engine) => {
            const results: import("../core/syncEngine.js").PushAllResult[] = [];
            for (const { workspaceId, label } of picks) {
              if (!selected.has(workspaceId)) continue;
              try {
                const r = await engine.pushAll(workspaceId, (ev) => {
                  if (ev.kind === "workspace_started") {
                    progress.report({ message: `${ev.workspaceNote} (${String(ev.index + 1)}/${String(ev.total)})…` });
                    channel.appendLine(`▶ ${ev.workspaceNote} (${ev.workspaceId})`);
                  } else if (ev.ok) {
                    channel.appendLine(`  ✓ pushed ${String(ev.pushedFiles)} file(s)`);
                  }
                });
                results.push(...r);
              } catch (e) {
                const error = e instanceof Error ? e.message : String(e);
                channel.appendLine(`  ✗ ${error}`);
                results.push({ workspaceId, ok: false, pushedFiles: 0, error });
                void label;
              }
            }
            channel.appendLine("");
            channel.appendLine(formatBulkPushResults(results));
          }, root);
        },
      );
    }),

    // F7 — Send activity-log digest to a webhook (Discord / Slack /
    // Telegram bot / generic). URL configured via `vscodesync.webhookDigestUrl`;
    // format auto-detected by URL host. Manual one-shot command; the
    // recurring daily/weekly schedule is left for a future fase.
    vscode.commands.registerCommand("vscodesync.sendWebhookDigest", async () => {
      const url = vscode.workspace
        .getConfiguration("vscodesync")
        .get<string>("webhookDigestUrl", "");
      if (!url) {
        const choice = await vscode.window.showWarningMessage(
          "VSCodeSync: задайте URL в `vscodesync.webhookDigestUrl` (Discord / Slack / Telegram bot).",
          "Открыть настройку",
        );
        if (choice === "Открыть настройку") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "vscodesync.webhookDigestUrl",
          );
        }
        return;
      }
      const root = pickRoot();
      if (!root) return;
      await runWithEngine(async (engine) => {
        void engine;
        const { loadActivityFile } = await import("../core/activityLog.js");
        const { buildWeeklyDigest } = await import("../core/insightsWeeklyDigest.js");
        const { detectWebhookFormat, formatDigestForWebhook } = await import(
          "../core/digestWebhookFormatter.js"
        );
        const storageDir = nodePath.join(os.homedir(), ".vscode", "vscodeSync");
        const file = await loadActivityFile(storageDir);
        const digest = buildWeeklyDigest({ events: file.events, nowMs: Date.now() });
        const format = detectWebhookFormat(url);
        const { contentType, body } = formatDigestForWebhook(digest, format);
        try {
          const { fetchWithTimeout } = await import("../providers/_shared/fetchWithTimeout.js");
          const r = await fetchWithTimeout(
            url,
            {
              method: "POST",
              headers: { "Content-Type": contentType },
              body,
            },
            { channel: "webhookDigest", timeoutMs: 15_000 },
          );
          if (!r.ok) {
            throw new Error(`HTTP ${String(r.status)} ${await r.text()}`);
          }
          void vscode.window.showInformationMessage(
            `Webhook digest отправлен (${format}, ${String(digest.totalEvents)} events).`,
          );
        } catch (e) {
          await vscode.window.showErrorMessage(
            `Webhook digest не отправлен: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }, root);
    }),

    // F1 — Smart Pull Digest: aggregate cloud_newer files by who-edited
    // them or workspace, render as a webview-friendly markdown summary.
    vscode.commands.registerCommand("vscodesync.showSmartPullDigest", async () => {
      const root = pickRoot();
      if (!root) return;
      const cfg = await WorkspaceConfigManager.load(root);
      const { buildSmartPullDigest } = await import("../core/smartPullDigestPlanner.js");
      const wsNote = (id: string): string | undefined =>
        cfg.activeWorkspaces.find((w) => w.workspaceId === id)?.workspaceNote;
      const digest = buildSmartPullDigest(
        cfg.files.map((f) => ({
          workspaceId: f.workspaceId,
          workspaceNote: wsNote(f.workspaceId),
          localPath: f.localPath,
          syncStatus: f.syncStatus,
          editingBy: f.editingBy,
          editingByName: f.editingByName,
          lastSync: f.lastSync,
        })),
      );
      if (digest.totalCloudNewer === 0 && digest.totalConflicts === 0) {
        void vscode.window.showInformationMessage(digest.headline);
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        digest.headline,
        { modal: false },
        "Bulk Pull...",
        "Подробнее",
      );
      if (choice === "Bulk Pull...") {
        await vscode.commands.executeCommand("vscodesync.openDivergences");
      } else if (choice === "Подробнее") {
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: `# Smart Pull Digest\n\n${digest.markdown}\n`,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }),

    // F8 — pre-flight before closing the laptop. Reads tracked files,
    // delegates verdict to pure planner, surfaces an info / warning with
    // action buttons. Pure planner = `goHomePreflightPlanner.ts`.
    vscode.commands.registerCommand("vscodesync.goHomePreflight", async () => {
      const root = pickRoot();
      if (!root) return;
      const cfg = await WorkspaceConfigManager.load(root);
      const { planGoHomePreflight, describeGoHomeVerdict } = await import(
        "../core/goHomePreflightPlanner.js"
      );
      const verdict = planGoHomePreflight(cfg.files);
      const headline = describeGoHomeVerdict(verdict);
      if (verdict.kind === "clean") {
        void vscode.window.showInformationMessage(headline);
        return;
      }
      if (verdict.kind === "pending_push") {
        const choice = await vscode.window.showWarningMessage(
          headline,
          "Push all",
          "Игнорировать",
        );
        if (choice === "Push all") {
          await runWithEngine(async (engine) => {
            await engine.pushAll();
            void vscode.window.showInformationMessage("✅ Push выполнен. Можно закрывать.");
          });
        }
        return;
      }
      if (verdict.kind === "cloud_newer") {
        const choice = await vscode.window.showInformationMessage(
          headline,
          "Bulk Pull...",
          "Закрыть как есть",
        );
        if (choice === "Bulk Pull...") {
          await vscode.commands.executeCommand("vscodesync.openDivergences");
        }
        return;
      }
      if (verdict.kind === "conflict") {
        await vscode.window.showErrorMessage(
          headline,
          { modal: false },
          "Открыть Workspaces",
        ).then((c) => {
          if (c === "Открыть Workspaces") {
            void vscode.commands.executeCommand("vscodesync.focusWorkspacesView");
          }
        });
        return;
      }
      // mixed
      await vscode.window.showWarningMessage(
        headline,
        "Открыть Workspaces",
      ).then((c) => {
        if (c === "Открыть Workspaces") {
          void vscode.commands.executeCommand("vscodesync.focusWorkspacesView");
        }
      });
    }),

    vscode.commands.registerCommand("vscodesync.pullAll", async () => {
      // Link Bindings (stage 2) — one batch-level placement question instead
      // of a silent mass materialization at recorded paths.
      const rootPath = pickRoot();
      if (rootPath !== undefined) {
        const wc = await WorkspaceConfigManager.load(rootPath);
        const missing = wc.files.filter((f) => f.syncStatus === "missing_local");
        if (missing.length > 0) {
          const choice = await vscode.window.showInformationMessage(
            `${String(missing.length)} файл(ов) ещё нет на этой машине. Разложить их по записанным путям (структура отправителя или ваши привязки)?`,
            { modal: true },
            "Принять",
            "Разобрать по одному",
          );
          if (choice === undefined) {
            return;
          }
          if (choice === "Разобрать по одному") {
            const rootUri = vscode.Uri.file(rootPath);
            for (const f of missing) {
              const outcome = await chooseMissingFilePlacement(
                runWithEngine,
                rootUri,
                f.workspaceId,
                f.localPath,
                f.manifestPath ?? f.localPath,
              );
              if (outcome.kind === "cancelled") {
                return;
              }
            }
          }
        }
      }
      await runWithEngine(
        async (engine) => {
          await engine.pullAll();
          void vscode.window.showInformationMessage("Pull all: готово.");
        },
        undefined,
        { cancellable: "VSCodeSync: скачивание всех воркспейсов…" },
      );
    }),

    // F4 — Bulk Pull (selectively). Quick-pick of files with syncStatus =
    // "cloud_newer" across all open folders; multi-select; per-file pull
    // with progress. Closes the "колеги обновили N файлов" workflow that
    // was the trigger for the v0.7 audit (manual one-by-one pull was
    // painful).

    vscode.commands.registerCommand("vscodesync.syncWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(
        async (engine) => {
          await engine.syncWorkspace(ws);
          void vscode.window.showInformationMessage(`Sync ${ws}: готово.`);
        },
        undefined,
        { cancellable: "VSCodeSync: синхронизация воркспейса…" },
      );
    }),

    vscode.commands.registerCommand("vscodesync.pushWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(
        async (engine) => {
          const results = await engine.pushAll(ws);
          void vscode.window.showInformationMessage(summarisePushForToast("Push workspace", results));
        },
        undefined,
        { cancellable: "VSCodeSync: отправка воркспейса…" },
      );
    }),

    vscode.commands.registerCommand("vscodesync.pullWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(
        async (engine) => {
          await engine.pullAll(ws);
          void vscode.window.showInformationMessage("Pull workspace: готово.");
        },
        undefined,
        { cancellable: "VSCodeSync: скачивание воркспейса…" },
      );
    }),
  ];
}
