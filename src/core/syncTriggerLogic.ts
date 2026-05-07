/** Pure helpers for sync triggers (unit-tested). */

export const DEFAULT_SAVE_DEBOUNCE_SEC = 3;

/** Milliseconds for debounced save-push: `saveDebounceSec` from workspace entry, or default 3s; `0` = immediate. */
export function resolveSaveDebounceMs(entry: { saveDebounceSec?: number } | undefined): number {
  const s = entry?.saveDebounceSec;
  if (s === undefined) {
    return DEFAULT_SAVE_DEBOUNCE_SEC * 1000;
  }
  if (s <= 0) {
    return 0;
  }
  return s * 1000;
}

/** Avoid auto sync churn when the machine-local cache file changes. */
export function isIgnoredSyncTriggerPath(fsPath: string): boolean {
  const n = fsPath.replace(/\\/g, "/").toLowerCase();
  return n.endsWith("/.vscode/vscodesync.json");
}
