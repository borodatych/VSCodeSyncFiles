/**
 * Insight panels — palette commands.
 *
 * Панели наблюдаемости: статистика, лента активности, тепловая карта конфликтов, отчёт по месту.
 *
 * Вынесено из `ui/plannedPaletteCommands.ts` (F12): 27 команд из семи доменов
 * жили в одном файле на 1115 строк, и добавление любой новой команды делало
 * его ещё менее читаемым.
 */
import * as vscode from "vscode";
import { openActivityFeedPanel } from "../../ui/activityFeedPanel.js";
import { setLastAppliedFilter } from "../../ui/activitySavedSearches.js";
import { openStatsDashboardPanel } from "../../ui/statsDashboardPanel.js";
import type { PaletteExtras } from "./_shared.js";

export function registerInsightsPanelCommands(
  context: vscode.ExtensionContext,
  extras: PaletteExtras,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.openStats", () => {
      openStatsDashboardPanel(context, extras.globalConfig.getStorageDir());
    }),
    vscode.commands.registerCommand("vscodesync.openActivityFeed", async () => {
      const gc = await extras.globalConfig.load();
      // Pull a pending saved-search filter from globalState (set by
      // `vscodesync.activityApplySavedSearch`) and clear it so the next plain
      // open doesn't re-apply it.
      const PENDING_KEY = "vscodesync.activity.pendingApplyFilter";
      const pending = context.globalState.get<unknown>(PENDING_KEY);
      const applyFilter =
        pending !== null && typeof pending === "object"
          ? (pending as { kind?: string; workspaceId?: string; query?: string })
          : undefined;
      if (applyFilter) {
        await context.globalState.update(PENDING_KEY, undefined);
      }
      openActivityFeedPanel(context, extras.globalConfig.getStorageDir(), gc.machineName, {
        applyFilter,
        onFilterChanged: (filter) => {
          void setLastAppliedFilter(context, filter);
        },
      });
    }),

    vscode.commands.registerCommand("vscodesync.showConflictHeatmap", async () => {
      const { getHotZones } = await import("../../ui/conflictHeatmapStoreFs.js");
      const zones = await getHotZones(extras.globalConfig.getStorageDir(), 1);
      if (zones.length === 0) {
        void vscode.window.showInformationMessage(
          "VSCodeSync: ещё нет записанных разрешений конфликтов.",
        );
        return;
      }
      const channel = vscode.window.createOutputChannel("VSCodeSync · conflict heatmap");
      channel.clear();
      channel.appendLine(`Hot files (${String(zones.length)}):`);
      channel.appendLine("");
      for (const z of zones) {
        channel.appendLine(`  ${String(z.count).padStart(3)} × ${z.relPath} (lines ${String(z.startLine)}-${String(z.endLine)})`);
      }
      channel.show(true);
    }),
    vscode.commands.registerCommand("vscodesync.showStorageReport", async () => {
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
        return;
      }
      const { CLOUD_ROOT_DIR } = await import("../../core/cloudLayout.js");
      // Walk one level (workspace dirs); for each, list manifest+meta+files
      // (depth ≤ 3 in practice; per-snapshot deep walk skipped — surfaces top-level).
      interface Entry { cloudPath: string; size?: number }
      const collect = async (dir: string, depth: number, into: Entry[]): Promise<void> => {
        if (depth > 4) return;
        let listing: Awaited<ReturnType<typeof provider.listFolder>>;
        try { listing = await provider.listFolder(dir); } catch { return; }
        for (const e of listing) {
          if (e.size === undefined) {
            await collect(e.cloudPath, depth + 1, into);
          } else {
            into.push({ cloudPath: e.cloudPath, size: e.size });
          }
        }
      };
      const all: Entry[] = [];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: подсчёт занятого места…", cancellable: false },
        async () => { await collect(CLOUD_ROOT_DIR, 0, all); },
      );
      const { buildStorageUsageReport, formatBytes } = await import("../../core/storageUsageReport.js");
      const report = buildStorageUsageReport(all, 10);
      const channel = vscode.window.createOutputChannel("VSCodeSync · storage report");
      channel.clear();
      channel.appendLine(`Всего файлов: ${String(report.totalFiles)} · ${formatBytes(report.totalBytes)}`);
      channel.appendLine("");
      channel.appendLine(`По workspace (${String(report.perWorkspace.length)}):`);
      for (const w of report.perWorkspace) {
        channel.appendLine(`  ${formatBytes(w.totalBytes).padStart(10)} · ${String(w.fileCount).padStart(5)} файлов · ${w.workspaceId}`);
      }
      channel.appendLine("");
      channel.appendLine(`Топ-${String(report.topFiles.length)} крупнейших файлов:`);
      for (const f of report.topFiles) {
        channel.appendLine(`  ${formatBytes(f.size).padStart(10)} · ${f.cloudPath}`);
      }
      channel.show(true);
    }),
  );
}
