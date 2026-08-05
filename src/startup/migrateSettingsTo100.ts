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

const CFG_SECTION = "vscodesync";
const DONE_KEY = "vscodesync.migration.100.done";

/** Settings deleted in 1.0.0 — cleaned from user files, with a log line. */
const REMOVED_KEYS: readonly string[] = [
  "syncSchedule",
  "syncScheduleExtended",
  "quietHours.start",
  "quietHours.end",
  "deltaSync",
  "deltaThresholdKB",
  "conflictRules",
  "lineEnding",
  "saveDebounceSecDefault",
  "watchIdleCyclesBeforeBackoff",
];

interface MigratableScope {
  readonly target: vscode.ConfigurationTarget;
  readonly label: string;
  readonly read: (info: ReturnType<vscode.WorkspaceConfiguration["inspect"]>) => unknown;
}

const SCOPES: readonly MigratableScope[] = [
  { target: vscode.ConfigurationTarget.Global, label: "user", read: (i) => i?.globalValue },
  { target: vscode.ConfigurationTarget.Workspace, label: "workspace", read: (i) => i?.workspaceValue },
  {
    target: vscode.ConfigurationTarget.WorkspaceFolder,
    label: "folder",
    read: (i) => i?.workspaceFolderValue,
  },
];

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
    let hadFull = false;
    const cleaned: string[] = [];

    // 1. autoSyncMode: full → check-only, per scope that actually set it.
    try {
      const mode = cfg.inspect<string>("autoSyncMode");
      for (const scope of SCOPES) {
        if (scope.read(mode) !== "full") continue;
        hadFull = true;
        try {
          await cfg.update("autoSyncMode", "check-only", scope.target);
          deps.log(`migration 1.0.0: autoSyncMode full → check-only (${scope.label})`);
        } catch {
          // Read-only settings surface (remote overrides) — parse fallback covers it.
        }
      }
    } catch {
      /* inspect can throw on exotic configuration providers — non-fatal */
    }

    // 2. Removed keys: wipe user values, log each.
    for (const key of REMOVED_KEYS) {
      try {
        const info = cfg.inspect(key);
        for (const scope of SCOPES) {
          if (scope.read(info) === undefined) continue;
          try {
            await cfg.update(key, undefined, scope.target);
            cleaned.push(`${key} (${scope.label})`);
            deps.log(`migration 1.0.0: removed setting ${key} (${scope.label})`);
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* unknown key shapes — skip */
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
