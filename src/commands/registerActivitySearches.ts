/**
 * Activity-feed saved-search commands. Pure registration — all state lives in
 * the providing modules (`activitySavedSearches`, `activityAlertMonitor`),
 * which use `globalState` directly.
 *
 * Carved out of `extension.ts` as part of the v2.6 decomposition. Other
 * "activity / monitor" surfaces should land here in the same module.
 */
import * as vscode from "vscode";
import {
  deleteSavedSearch,
  getLastAppliedFilter,
  listSavedSearches,
  upsertSavedSearch,
} from "../ui/activitySavedSearches.js";
import { listAlertingFilterIds, setAlertingFilterIds } from "../ui/activityAlertMonitor.js";

export interface ActivitySearchCommandsDeps {
  context: vscode.ExtensionContext;
}

export function registerActivitySearchCommands(
  deps: ActivitySearchCommandsDeps,
): vscode.Disposable[] {
  const { context } = deps;
  return [
    vscode.commands.registerCommand("vscodesync.activitySaveCurrentSearch", async () => {
      const filter = getLastAppliedFilter(context) ?? {};
      const isEmpty =
        !filter.kind && !filter.workspaceId && !(filter.query ?? "").trim();
      if (isEmpty) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: примените фильтр в Activity Feed (kind / workspace / query) перед сохранением.",
        );
        return;
      }
      const name = await vscode.window.showInputBox({
        title: "VSCodeSync · сохранить фильтр Activity",
        prompt: "Имя для сохранённого фильтра",
        placeHolder: "например, conflicts-this-week",
      });
      if (!name?.trim()) return;
      const entry = await upsertSavedSearch(context, name.trim(), filter);
      void vscode.window.showInformationMessage(
        `VSCodeSync: фильтр «${entry.name}» сохранён.`,
      );
    }),

    vscode.commands.registerCommand("vscodesync.activityApplySavedSearch", async () => {
      const items = listSavedSearches(context);
      if (items.length === 0) {
        void vscode.window.showInformationMessage(
          "VSCodeSync: нет сохранённых фильтров. Примените фильтр в Activity Feed и сохраните его.",
        );
        return;
      }
      type Pick = vscode.QuickPickItem & { id: string };
      const picks: Pick[] = items.map((s) => ({
        id: s.id,
        label: s.name,
        description: [
          s.filter.kind ? `kind=${s.filter.kind}` : "",
          s.filter.workspaceId ? `ws=${s.filter.workspaceId.slice(0, 8)}…` : "",
          s.filter.query ? `q="${s.filter.query}"` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }));
      const picked = await vscode.window.showQuickPick(picks, {
        placeHolder: "Сохранённые фильтры Activity",
      });
      if (!picked) return;
      const target = items.find((i) => i.id === picked.id);
      if (!target) return;
      await context.globalState.update(
        "vscodesync.activity.pendingApplyFilter",
        target.filter,
      );
      await vscode.commands.executeCommand("vscodesync.openActivityFeed");
    }),

    vscode.commands.registerCommand("vscodesync.activityDeleteSavedSearch", async () => {
      const items = listSavedSearches(context);
      if (items.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: нет сохранённых фильтров.");
        return;
      }
      type Pick = vscode.QuickPickItem & { id: string };
      const picks: Pick[] = items.map((s) => ({ id: s.id, label: s.name }));
      const picked = await vscode.window.showQuickPick(picks, {
        placeHolder: "Удалить сохранённый фильтр",
      });
      if (!picked) return;
      const ok = await deleteSavedSearch(context, picked.id);
      if (ok) {
        void vscode.window.showInformationMessage(`VSCodeSync: «${picked.label}» удалён.`);
      }
    }),

    vscode.commands.registerCommand(
      "vscodesync.activityToggleAlertingForSearch",
      async () => {
        const items = listSavedSearches(context);
        if (items.length === 0) {
          void vscode.window.showInformationMessage(
            "VSCodeSync: нет сохранённых фильтров. Сначала сохраните фильтр.",
          );
          return;
        }
        const alerting = new Set(listAlertingFilterIds(context));
        type Pick = vscode.QuickPickItem & { id: string };
        const picks: Pick[] = items.map((s) => ({
          id: s.id,
          label: s.name,
          description: alerting.has(s.id) ? "$(bell) alerting" : "$(bell-slash) muted",
          picked: alerting.has(s.id),
        }));
        const chosen = await vscode.window.showQuickPick(picks, {
          placeHolder: "Включить toast-уведомления для этих фильтров",
          canPickMany: true,
        });
        if (!chosen) return;
        await setAlertingFilterIds(context, chosen.map((c) => c.id));
        void vscode.window.showInformationMessage(
          chosen.length === 0
            ? "VSCodeSync: alerting отключён."
            : `VSCodeSync: alerting активен для ${String(chosen.length)} фильтр${chosen.length === 1 ? "а" : "ов"}.`,
        );
      },
    ),
  ];
}
