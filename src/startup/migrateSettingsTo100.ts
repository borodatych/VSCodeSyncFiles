/**
 * One-shot settings migration to the 1.0.0 model (stage 3.4, §654).
 *
 * Two things changed underneath the user's settings.json:
 *
 * - `autoSyncMode: "full"` no longer exists. The value is rewritten to
 *   `check-only` in every scope where the user had set it, and — because this
 *   flips behaviour they explicitly opted into — a one-time notification says
 *   so in plain words. This is the only part of the migration that talks.
 * - Eight settings were removed outright (schedule, quiet hours, delta sync,
 *   conflict rules, line endings, two unwired watch knobs). Leftover keys are
 *   cleaned from settings.json so VS Code stops flagging them as unknown; each
 *   removal is logged to the startup channel.
 *
 * The migration runs once per machine (globalState marker), is idempotent by
 * construction (rewrites only values that exist), and never blocks activate —
 * `parseAutoSyncMode` already reads a stray `"full"` as `check-only`, so a
 * machine where this failed still behaves safely.
 */
import * as vscode from "vscode";
import {
  REMOVED_SETTINGS_100,
  planSettingsMigration,
  type MigrationScope,
  type SettingSnapshot,
} from "../core/settingsMigrationPlan.js";

const CFG_SECTION = "vscodesync";
const DONE_KEY = "vscodesync.migration.100.done";

const SCOPE_TARGET: Record<MigrationScope, vscode.ConfigurationTarget> = {
  user: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
  folder: vscode.ConfigurationTarget.WorkspaceFolder,
};

/** Fold one `inspect` result into the planner's scope→value shape. */
function snapshotOf(
  info: ReturnType<vscode.WorkspaceConfiguration["inspect"]>,
): SettingSnapshot | undefined {
  if (!info) return undefined;
  return {
    user: info.globalValue,
    workspace: info.workspaceValue,
    folder: info.workspaceFolderValue,
  };
}

export interface MigrateSettingsDeps {
  context: vscode.ExtensionContext;
  /** Startup output channel — the paper trail for every silent cleanup. */
  log: (line: string) => void;
  /** Pending offline-queue items, reported (not executed) per §660. */
  countPendingOfflineOps: () => Promise<number>;
}

export function migrateSettingsTo100(deps: MigrateSettingsDeps): void {
  void (async (): Promise<void> => {
    if (deps.context.globalState.get<boolean>(DONE_KEY) === true) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration(CFG_SECTION);

    // Decide first (pure, tested), then execute. `planSettingsMigration` only
    // returns actions for values that exist, so re-running is a no-op.
    const snapshots: Record<string, SettingSnapshot | undefined> = {};
    for (const key of ["autoSyncMode", ...REMOVED_SETTINGS_100]) {
      try {
        snapshots[key] = snapshotOf(cfg.inspect(key));
      } catch {
        /* inspect can throw on exotic configuration providers — skip key */
      }
    }
    const plan = planSettingsMigration(snapshots);
    const hadFull = plan.hadFull;
    const cleaned: string[] = [];

    for (const action of plan.actions) {
      try {
        await cfg.update(action.key, action.value, SCOPE_TARGET[action.scope]);
        if (action.kind === "rewrite-mode") {
          deps.log(`migration 1.0.0: autoSyncMode full → check-only (${action.scope})`);
        } else {
          cleaned.push(`${action.key} (${action.scope})`);
          deps.log(`migration 1.0.0: removed setting ${action.key} (${action.scope})`);
        }
      } catch {
        // Read-only settings surface (remote overrides) — best-effort; the
        // `parseAutoSyncMode` fallback keeps a stray "full" safe regardless.
      }
    }

    // The marker is written before the notifications: they are informational,
    // and re-running the toasts on every start would be worse than missing one.
    await deps.context.globalState.update(DONE_KEY, true);

    if (hadFull) {
      const picked = await vscode.window.showInformationMessage(
        "VSCodeSync 1.0.0: расширение больше не синхронизирует файлы само. " +
          "Ваш режим переключён на «только проверка»: расхождения показываются в панели, " +
          "отправка и скачивание — по вашей команде.",
        "Понятно",
        "Что изменилось",
      );
      if (picked === "Что изменилось") {
        await vscode.commands.executeCommand("vscodesync.openDivergences");
      }
    } else if (cleaned.length > 0) {
      void vscode.window.showInformationMessage(
        `VSCodeSync 1.0.0: из настроек убраны удалённые ключи (${String(cleaned.length)}) — подробности в Output «VSCodeSync · Startup».`,
      );
    }

    // 3. §660 — a non-empty offline queue is reported, never executed.
    try {
      const pending = await deps.countPendingOfflineOps();
      if (pending > 0) {
        const picked = await vscode.window.showInformationMessage(
          `VSCodeSync 1.0.0: осталось ${String(pending)} отложенных операций — просмотреть?`,
          "Показать",
        );
        if (picked === "Показать") {
          await vscode.commands.executeCommand("vscodesync.openDivergences");
        }
      }
    } catch {
      /* queue store unavailable — nothing to report */
    }
  })();
}
