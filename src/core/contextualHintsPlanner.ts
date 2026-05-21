/**
 * v0.10 F-026 — pure planner for contextual hint surfacing.
 *
 * Host invokes this on focus regain / workspace-tree refresh; if the
 * planner emits any hint, the UI shows ONE info-message with the
 * dedup-key carried via `id`. The host stores shown ids in globalState
 * to avoid repeating the same hint within `dedupWindowMs`.
 */

export type ContextualHintKind =
  | "many_conflicts"
  | "all_workspaces_frozen"
  | "quota_high"
  | "auto_sync_paused_long";

export interface ContextualHint {
  id: ContextualHintKind;
  text: string;
  /** Command id to invoke when the user accepts the hint, or undefined for info-only. */
  actionCommandId?: string;
  /** Severity for the UI to map to icon/colour. */
  severity: "info" | "warn";
}

export interface ContextualHintsInput {
  /** Total conflicts across all workspaces. */
  conflictCount: number;
  /** All active workspaces are in frozen state. */
  allWorkspacesFrozen: boolean;
  /** Active workspace count (used to confirm "all frozen" isn't trivially 0). */
  activeWorkspaceCount: number;
  /** Quota usage ratio across active providers (0–1). */
  quotaUsageRatio?: number;
  /** ms since `autoSyncMode` was switched to off (undefined = not off). */
  autoSyncOffSinceMs?: number;
  /** Wall-clock now. */
  nowMs: number;
}

export interface ContextualHintsOptions {
  /** Show "many conflicts" when at least this many. Default 5. */
  manyConflictsThreshold?: number;
  /** Show "quota_high" when ratio >= this. Default 0.9. */
  quotaHighThreshold?: number;
  /** "auto sync paused long" appears after this many days. Default 7. */
  autoSyncPausedDays?: number;
}

const DAY_MS = 86_400_000;

export function planContextualHints(
  input: ContextualHintsInput,
  opts: ContextualHintsOptions = {},
): ContextualHint[] {
  const manyConflicts = Math.max(1, opts.manyConflictsThreshold ?? 5);
  const quotaCutoff = Math.max(0, Math.min(1, opts.quotaHighThreshold ?? 0.9));
  const offDaysCutoff = Math.max(1, opts.autoSyncPausedDays ?? 7);

  const hints: ContextualHint[] = [];

  if (input.conflictCount >= manyConflicts) {
    hints.push({
      id: "many_conflicts",
      severity: "warn",
      text: `VSCodeSync: ${String(input.conflictCount)} файлов в состоянии conflict. Хотите разрешить разом?`,
      actionCommandId: "vscodesync.resolveConflicts",
    });
  }
  if (input.activeWorkspaceCount > 0 && input.allWorkspacesFrozen) {
    hints.push({
      id: "all_workspaces_frozen",
      severity: "warn",
      text: "VSCodeSync: все workspace заморожены (Freeze). Снять заморозку?",
      actionCommandId: "vscodesync.showSyncSummary",
    });
  }
  if (input.quotaUsageRatio !== undefined && input.quotaUsageRatio >= quotaCutoff) {
    const pct = Math.round(input.quotaUsageRatio * 100);
    // v0.17 A6 — point to existing SBOM export instead of phantom
    // openStorageReport command. SBOM lists heaviest files which is the
    // first thing the user wants to see when quota is full.
    hints.push({
      id: "quota_high",
      severity: "warn",
      text: `VSCodeSync: облачное хранилище заполнено на ${String(pct)}%. Откройте отчёт о синкаемых файлах для очистки.`,
      actionCommandId: "vscodesync.exportSbom",
    });
  }
  if (
    input.autoSyncOffSinceMs !== undefined &&
    input.nowMs - input.autoSyncOffSinceMs >= offDaysCutoff * DAY_MS
  ) {
    const days = Math.floor((input.nowMs - input.autoSyncOffSinceMs) / DAY_MS);
    hints.push({
      id: "auto_sync_paused_long",
      severity: "info",
      text: `VSCodeSync: автосинхронизация отключена ${String(days)} дней. Хотите включить full режим?`,
      actionCommandId: "vscodesync.cycleAutoSyncMode",
    });
  }
  return hints;
}
