/**
 * v0.7 — pure helper for the `vscodesync.autoSyncMode` setting.
 *
 * Why a separate module: every auto-sync trigger needs to gate on the
 * mode (`off` / `check-only` / `full`). Centralising the parse + helper
 * keeps the behaviour consistent across `syncTriggerManager`,
 * `watchModePoller`, `quietFullSyncAllFolders`, `runAfterSessionResume`,
 * and the Git push-on-commit path.
 *
 * No `vscode` import — call sites read the raw setting string and pass it
 * in. Resolver-shaped so future per-workspace overrides become trivial.
 */

export type AutoSyncMode = "off" | "check-only" | "full";

export const DEFAULT_AUTO_SYNC_MODE: AutoSyncMode = "check-only";

/** Normalise an arbitrary string into a valid mode (unknown → default). */
export function parseAutoSyncMode(raw: string | undefined): AutoSyncMode {
  if (raw === "off") return "off";
  if (raw === "full") return "full";
  if (raw === "check-only") return "check-only";
  return DEFAULT_AUTO_SYNC_MODE;
}

/** True when *any* automatic sync activity is allowed (status check or full). */
export function isAutoCheckEnabled(mode: AutoSyncMode): boolean {
  return mode !== "off";
}

/** True only when full auto push / pull is allowed (legacy behaviour). */
export function isAutoFullSyncEnabled(mode: AutoSyncMode): boolean {
  return mode === "full";
}

/** Short human-readable label for the status bar tooltip. */
export function describeAutoSyncMode(mode: AutoSyncMode): string {
  switch (mode) {
    case "off":
      return "Авто-синхронизация выключена";
    case "check-only":
      return "Авто-режим: только проверка статусов (push/pull только вручную)";
    case "full":
      return "Авто-синхронизация: полная (push на save, pull на open)";
  }
}
