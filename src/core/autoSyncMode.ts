/**
 * v0.7 — pure helper for the `vscodesync.autoSyncMode` setting.
 *
 * Why a separate module: every automatic trigger gates on the mode.
 * Centralising the parse + helpers keeps the behaviour consistent across
 * `syncTriggerManager`, `watchModePoller`, `quietFullSyncAllFolders`,
 * `runAfterSessionResume`, and the Git push-on-commit path.
 *
 * 1.0.0 (stage 3.4): the `full` mode is gone. It meant "automatic sources
 * move files", which the mutation checkpoint forbids — every code path it
 * gated was already refused by the engine, so the value promised behaviour
 * that could not happen. Automatic triggers are detectors now: they recount
 * statuses, and moving data is the panel's job. `parseAutoSyncMode` still
 * accepts the literal `"full"` from old settings files and reads it as
 * `check-only`, so a machine that missed the one-shot migration degrades to
 * the safe mode instead of an accidental default.
 *
 * No `vscode` import — call sites read the raw setting string and pass it
 * in. Resolver-shaped so future per-workspace overrides become trivial.
 */

export type AutoSyncMode = "off" | "check-only";

export const DEFAULT_AUTO_SYNC_MODE: AutoSyncMode = "check-only";

/** Normalise an arbitrary string into a valid mode (unknown → default). */
export function parseAutoSyncMode(raw: string | undefined): AutoSyncMode {
  if (raw === "off") return "off";
  if (raw === "check-only") return "check-only";
  // Legacy value from a pre-1.0.0 settings.json — reads as check-only.
  if (raw === "full") return "check-only";
  return DEFAULT_AUTO_SYNC_MODE;
}

/** True when automatic status checking is allowed. */
export function isAutoCheckEnabled(mode: AutoSyncMode): boolean {
  return mode !== "off";
}

/** Short human-readable label for the status bar tooltip. */
export function describeAutoSyncMode(mode: AutoSyncMode): string {
  switch (mode) {
    case "off":
      return "Авто-проверка выключена";
    case "check-only":
      return "Авто-режим: только проверка статусов (push/pull только вручную)";
  }
}
