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
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { pickRoot, pickWorkspaceId } from "./_shared.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface SyncOpsCommandsDeps {
  runWithEngine: RunWithEngineFn;
}

export function registerSyncOpsCommands(deps: SyncOpsCommandsDeps): vscode.Disposable[] {
  const { runWithEngine } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.pushAll", async () => {
      await runWithEngine(async (engine) => {
        await engine.pushAll();
        await vscode.window.showInformationMessage("Push all: готово.");
      });
    }),

    vscode.commands.registerCommand("vscodesync.bulkPush", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const cfg = await WorkspaceConfigManager.load(root);
      if (cfg.activeWorkspaces.length === 0) {
        await vscode.window.showInformationMessage("VSCodeSync: нет активных workspace для push.");
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
        await vscode.window.showInformationMessage("VSCodeSync: нет workspace c файлами для push.");
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

    vscode.commands.registerCommand("vscodesync.pullAll", async () => {
      await runWithEngine(async (engine) => {
        await engine.pullAll();
        await vscode.window.showInformationMessage("Pull all: готово.");
      });
    }),

    // F4 — Bulk Pull (selectively). Quick-pick of files with syncStatus =
    // "cloud_newer" across all open folders; multi-select; per-file pull
    // with progress. Closes the "колеги обновили N файлов" workflow that
    // was the trigger for the v0.7 audit (manual one-by-one pull was
    // painful).
    vscode.commands.registerCommand("vscodesync.bulkPullSelected", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const cfg = await WorkspaceConfigManager.load(root);
      const cloudNewerFiles = cfg.files.filter((f) => f.syncStatus === "cloud_newer");
      if (cloudNewerFiles.length === 0) {
        await vscode.window.showInformationMessage(
          "VSCodeSync: нет файлов в состоянии «облако новее» — нечего скачивать.",
        );
        return;
      }
      const wsNote = (id: string): string =>
        cfg.activeWorkspaces.find((w) => w.workspaceId === id)?.workspaceNote ?? id.slice(0, 8);
      const picks = await vscode.window.showQuickPick(
        cloudNewerFiles.map((f) => ({
          label: f.localPath,
          description: `${wsNote(f.workspaceId)} · ${f.editingByName ?? ""}`.trim(),
          picked: true,
          workspaceId: f.workspaceId,
          posixRel: f.localPath,
        })),
        {
          canPickMany: true,
          title: `Bulk Pull — ${String(cloudNewerFiles.length)} файл(ов) «облако новее»`,
          placeHolder: "Выберите файлы (Space — toggle, Enter — скачать)",
        },
      );
      if (!picks || picks.length === 0) {
        return;
      }
      const channel = vscode.window.createOutputChannel("VSCodeSync · Bulk Pull");
      channel.clear();
      channel.show(true);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "VSCodeSync · Bulk Pull",
          cancellable: false,
        },
        async (progress) => {
          await runWithEngine(async (engine) => {
            let done = 0;
            let failed = 0;
            const total = picks.length;
            const liveCfg = await WorkspaceConfigManager.load(root);
            for (const p of picks) {
              progress.report({
                message: `${p.posixRel} (${String(done + 1)}/${String(total)})`,
                increment: 100 / total,
              });
              try {
                await engine.pullFile(liveCfg, p.workspaceId, p.posixRel);
                channel.appendLine(`  ✓ ${p.posixRel}`);
                done += 1;
              } catch (e) {
                failed += 1;
                channel.appendLine(`  ✗ ${p.posixRel}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            channel.appendLine("");
            channel.appendLine(
              `Bulk Pull: ${String(done)} OK · ${String(failed)} fail · ${String(total)} total`,
            );
          }, root);
        },
      );
    }),

    vscode.commands.registerCommand("vscodesync.syncWorkspace", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const ws = await pickWorkspaceId(root);
      if (!ws) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.syncWorkspace(ws);
        await vscode.window.showInformationMessage(`Sync ${ws}: готово.`);
      });
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
      await runWithEngine(async (engine) => {
        await engine.pushAll(ws);
        await vscode.window.showInformationMessage("Push workspace: готово.");
      });
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
      await runWithEngine(async (engine) => {
        await engine.pullAll(ws);
        await vscode.window.showInformationMessage("Pull workspace: готово.");
      });
    }),
  ];
}
