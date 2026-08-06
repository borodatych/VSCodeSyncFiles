/**
 * The decision half of the 1.0.0 settings migration (stage 3.4).
 *
 * `migrateSettingsTo100` runs exactly once per machine and cannot be
 * re-executed by a developer chasing a bug report, so the part that decides
 * *what to change* lives here as a pure function over a snapshot of
 * `WorkspaceConfiguration.inspect` values. The startup module only executes
 * the returned actions and shows the notifications.
 */

/** Settings deleted in 1.0.0 — leftovers are wiped from the user's files. */
export const REMOVED_SETTINGS_100: readonly string[] = [
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

export type MigrationScope = "user" | "workspace" | "folder";

/** What one key looks like across scopes, as read from `inspect`. */
export type SettingSnapshot = Partial<Record<MigrationScope, unknown>>;

export interface MigrationAction {
  key: string;
  scope: MigrationScope;
  /** `undefined` clears the key in that scope. */
  value: string | undefined;
  kind: "rewrite-mode" | "remove";
}

export interface MigrationPlan {
  actions: MigrationAction[];
  /** True when any scope carried `autoSyncMode: "full"` — drives the toast. */
  hadFull: boolean;
}

const SCOPES: readonly MigrationScope[] = ["user", "workspace", "folder"];

/**
 * Decide every write the migration must make.
 *
 * Only values that actually exist produce actions, which is what makes the
 * migration idempotent: running the plan twice yields an empty second plan.
 */
export function planSettingsMigration(
  snapshots: Readonly<Record<string, SettingSnapshot | undefined>>,
): MigrationPlan {
  const actions: MigrationAction[] = [];
  let hadFull = false;

  const mode = snapshots.autoSyncMode;
  for (const scope of SCOPES) {
    if (mode?.[scope] !== "full") continue;
    hadFull = true;
    actions.push({ key: "autoSyncMode", scope, value: "check-only", kind: "rewrite-mode" });
  }

  for (const key of REMOVED_SETTINGS_100) {
    const snap = snapshots[key];
    if (!snap) continue;
    for (const scope of SCOPES) {
      if (snap[scope] === undefined) continue;
      actions.push({ key, scope, value: undefined, kind: "remove" });
    }
  }

  return { actions, hadFull };
}
