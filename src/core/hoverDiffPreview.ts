/**
 * Hover Diff Preview — pure summary helpers for the editor hover.
 *
 * `summariseHoverDiff` is the original "with full _meta record" path: shows
 * file size and editor machine for cases where the caller has cached meta.
 * `summariseHoverDiffMinimal` is the path the actual VS Code HoverProvider
 * uses today — works off local config only (relPath, syncStatus, lastSync
 * timestamp + machine), no provider round-trips.
 */

export interface HoverDiffSummaryInput {
  relPath: string;
  localHash: string | null;
  cloudHash: string;
  cloudSize: number;
  cloudUpdatedAtMs: number;
  cloudEditorMachine: string;
}

export function summariseHoverDiff(input: HoverDiffSummaryInput): string {
  if (input.localHash === input.cloudHash) {
    return `${input.relPath}: identical to cloud version.`;
  }
  const sizeKb = (input.cloudSize / 1024).toFixed(1);
  const ageMin = Math.max(Math.round((Date.now() - input.cloudUpdatedAtMs) / 60_000), 0);
  return `${input.relPath}: cloud is ${sizeKb} KB, edited by ${input.cloudEditorMachine} ~${String(ageMin)} min ago.`;
}

export type HoverSyncStatus = "ok" | "cloud_newer" | "conflict";

export interface HoverDiffSummaryMinimalInput {
  relPath: string;
  syncStatus: HoverSyncStatus;
  /** Epoch ms of the most recent sync we know about; null = never synced. */
  lastSyncAtMs: number | null;
  /** Machine that last touched this file in the cloud, or empty if unknown. */
  lastSyncByMachine: string;
  nowMs?: number;
}

function ageInWords(deltaMs: number): string {
  if (deltaMs < 0) return "только что";
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "только что";
  if (min < 60) return `${String(min)} мин назад`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${String(hr)} ч назад`;
  const day = Math.floor(hr / 24);
  return `${String(day)} дн назад`;
}

export function summariseHoverDiffMinimal(input: HoverDiffSummaryMinimalInput): string | null {
  const now = input.nowMs ?? Date.now();
  const ageStr =
    input.lastSyncAtMs !== null && Number.isFinite(input.lastSyncAtMs)
      ? ageInWords(now - input.lastSyncAtMs)
      : "ещё не синхронизирован";
  const who = input.lastSyncByMachine.length > 0 ? ` (${input.lastSyncByMachine})` : "";
  switch (input.syncStatus) {
    case "cloud_newer":
      return `Облачная версия новее: последний sync ${ageStr}${who}. Pull, чтобы получить.`;
    case "conflict":
      return `Конфликт: локальная и облачная версии расходятся${who}. Используйте Resolve Conflicts.`;
    case "ok":
      return `Синхронизирован ${ageStr}${who}.`;
    default:
      return null;
  }
}
