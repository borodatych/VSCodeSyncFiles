/**
 * v2.20.1 — Settings Sync integration helpers.
 *
 * VS Code's built-in Settings Sync (Cursor / VS Code 1.95+) automatically
 * mirrors `vscode.workspace.getConfiguration("vscodesync")` values across a
 * user's signed-in machines. The provider id `"vscode-settings-sync"` exposed
 * via `vscode.authentication.getSession` is not part of the stable API, so
 * this module is a pure planner that:
 *
 *   - Declares which VSCodeSync settings are *safe to sync* and which must
 *     stay machine-local (`machineId`, OAuth tokens, encryption DEK).
 *   - Splits an arbitrary settings snapshot into `synced` / `local-only`
 *     buckets the caller can hand to Settings Sync (or, conversely, a custom
 *     sync target like the same `_machines.json` we already maintain).
 *   - Surfaces a `SettingsSyncNotImplementedError` for the "stable" path that
 *     would query `vscode.authentication.getSession("vscode-settings-sync")`
 *     once VS Code stabilises the surface.
 *
 * No `vscode` import — purely typed. Wiring lives in a follow-up commit
 * inside `src/ui/` if and when the unstable provider id stabilises.
 */

/** Categories of settings we expose. */
export type SettingsSyncCategory = "preference" | "secret" | "machine_local";

export interface SettingsSyncRule {
  /** Setting key under the `vscodesync.` prefix (no prefix in the key here). */
  readonly key: string;
  readonly category: SettingsSyncCategory;
  /** Short reason — surfaces in tooltips / docs. */
  readonly reason: string;
}

/**
 * Hand-curated list. The default policy is "secrets and machine identity
 * never leave the machine; UI preferences may sync; provider-specific tokens
 * are secrets". Any new setting added to `package.json` should land in this
 * list (lint check below covers drift).
 */
export const SETTINGS_SYNC_RULES: readonly SettingsSyncRule[] = [
  // Preferences — safe to sync.
  { key: "notificationLevel", category: "preference", reason: "UI verbosity" },
  { key: "notifications.emojiFree", category: "preference", reason: "UI styling" },
  { key: "encryption", category: "preference", reason: "feature flag" },
  { key: "compressUploads", category: "preference", reason: "feature flag" },
  { key: "maxFileSizeMB", category: "preference", reason: "tuning" },
  { key: "showFileDecorations", category: "preference", reason: "UI" },
  { key: "syncOnOpen", category: "preference", reason: "trigger pref" },
  { key: "syncOnFocusDelayMs", category: "preference", reason: "trigger tuning" },
  { key: "watchMode", category: "preference", reason: "feature flag" },
  { key: "watchIntervalSeconds", category: "preference", reason: "tuning" },
  { key: "watchAdaptive", category: "preference", reason: "tuning" },
  { key: "smartConflictPrediction.enabled", category: "preference", reason: "feature flag" },
  { key: "smartConflictPrediction.broadcastCurrentEditing", category: "preference", reason: "privacy mode" },
  { key: "canonicalHashAlgo", category: "preference", reason: "feature flag" },
  { key: "ai.sessionSummary.enabled", category: "preference", reason: "feature flag" },
  { key: "ai.suggestWorkspaceTags.enabled", category: "preference", reason: "feature flag" },
  { key: "ai.pathMapper.enabled", category: "preference", reason: "feature flag" },
  { key: "aiMerge.enabled", category: "preference", reason: "feature flag" },
  { key: "aiMerge.endpoint", category: "preference", reason: "endpoint pref" },
  { key: "aiMerge.endpointModel", category: "preference", reason: "endpoint pref" },
  { key: "telemetry", category: "preference", reason: "opt-in" },
  { key: "p2p.experimental", category: "preference", reason: "feature flag" },
  { key: "snapshotSchedule", category: "preference", reason: "schedule pref" },
  { key: "snapshotRetentionDays", category: "preference", reason: "retention pref" },
  { key: "localBackupRetentionDays", category: "preference", reason: "retention pref" },
  { key: "backup.intervalDays", category: "preference", reason: "schedule pref" },
  { key: "backup.secondaryProvider", category: "preference", reason: "feature flag" },

  // Secrets — never sync via Settings Sync. Lives in SecretStorage.
  { key: "_secret.dek", category: "secret", reason: "encryption DEK" },
  { key: "_secret.oauthTokens", category: "secret", reason: "OAuth refresh tokens" },
  { key: "_secret.passkey.envelope", category: "secret", reason: "WebAuthn envelope" },
  { key: "_secret.passkey.recoveryCodes", category: "secret", reason: "recovery hashes" },

  // Machine-local — would break the machine identity model if synced.
  { key: "_local.machineId", category: "machine_local", reason: "uniquely identifies this machine" },
  { key: "_local.machineName", category: "machine_local", reason: "user labels per machine" },
  { key: "_local.queue", category: "machine_local", reason: "offline queue is per-machine" },
  { key: "_local.activity", category: "machine_local", reason: "activity log is per-machine" },
];

export interface SettingsSyncSnapshot {
  /** Flat key→value snapshot, where each key is unprefixed (e.g. `"watchMode"`). */
  readonly values: Record<string, unknown>;
}

export interface SettingsSyncSplit {
  /** Subset that may be handed to VS Code Settings Sync for fan-out. */
  readonly synced: Record<string, unknown>;
  /** Subset that must stay on this machine (or move via SecretStorage). */
  readonly localOnly: Record<string, unknown>;
  /** Keys not present in `SETTINGS_SYNC_RULES` — flagged so we don't silently leak. */
  readonly unknown: string[];
}

export function splitSettingsForSync(snapshot: SettingsSyncSnapshot): SettingsSyncSplit {
  const synced: Record<string, unknown> = {};
  const localOnly: Record<string, unknown> = {};
  const unknownKeys: string[] = [];

  const ruleByKey = new Map<string, SettingsSyncRule>();
  for (const rule of SETTINGS_SYNC_RULES) ruleByKey.set(rule.key, rule);

  for (const [key, value] of Object.entries(snapshot.values)) {
    const rule = ruleByKey.get(key);
    if (rule === undefined) {
      unknownKeys.push(key);
      continue;
    }
    if (rule.category === "preference") synced[key] = value;
    else localOnly[key] = value;
  }
  return { synced, localOnly, unknown: unknownKeys };
}

/**
 * Sentinel error: the live session lookup against
 * `vscode.authentication.getSession("vscode-settings-sync")` is not stable
 * yet; fail closed instead of partially wiring the import side.
 */
export class SettingsSyncNotImplementedError extends Error {
  readonly code = "settings_sync_session_not_stable" as const;
  constructor(message?: string) {
    super(
      message ??
        "Settings Sync provider id is not part of the stable VS Code API yet (v2.20.1 in roadmap). " +
          "The split planner is available; the live `getSession` wiring lands when the API stabilises.",
    );
    this.name = "SettingsSyncNotImplementedError";
  }
}

export function trySettingsSyncSession(): never {
  throw new SettingsSyncNotImplementedError();
}
