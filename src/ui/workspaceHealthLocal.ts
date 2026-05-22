import type { WorkspaceConfig } from "../core/types.js";

/**
 * Workspace health level (7-stage palette).
 *
 * Priority (first-match-wins):
 *   conflict > editing > noData > staleDeep > staleOk > recent > fresh
 *
 * The four green stages share one emoji (🟢) but differ in shade through
 * `workspaceHealthThemeColor` applied to the tree's cloud icon.
 */
export type WorkspaceHealthLevel =
  | "conflict"
  | "editing"
  | "noData"
  | "staleDeep"
  | "staleOk"
  | "recent"
  | "fresh";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

// Green-shade thresholds (max(lastSync) age, ms).
const FRESH_MAX_MS = 12 * HOUR_MS;       // < 12 h
const RECENT_MAX_MS = 48 * HOUR_MS;      // 12–48 h
const STALE_OK_MAX_MS = 14 * DAY_MS;     // 2–14 d
// Above 14 d → staleDeep.

function parseIsoMs(s: string): number | undefined {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Local-only workspace-health evaluation from `vscodesync.json`
 * (no cloud round-trips). Mirrors the metrics shown by Health Check.
 */
export function workspaceHealthFromLocalCfg(
  wc: WorkspaceConfig,
  workspaceId: string,
): { level: WorkspaceHealthLevel; summaryLines: string[] } {
  const files = wc.files.filter((f) => f.workspaceId === workspaceId);

  const conflicts = files.filter((f) => f.syncStatus === "conflict");
  if (conflicts.length > 0) {
    const lines = conflicts.slice(0, 5).map((f) => `Конфликт: ${f.localPath}`);
    if (conflicts.length > 5) {
      lines.push(`… и ещё ${String(conflicts.length - 5)}`);
    }
    return { level: "conflict", summaryLines: lines };
  }

  const staleLocked = files.filter((f) => f.editingBy);
  if (staleLocked.length > 0) {
    const names = staleLocked.slice(0, 3).map((f) =>
      `${f.localPath} (✏️ ${f.editingByName ?? f.editingBy ?? "?"} редактирует)`,
    );
    return { level: "editing", summaryLines: names };
  }

  if (files.length === 0) {
    return { level: "noData", summaryLines: ["Нет отслеживаемых файлов"] };
  }

  let newest = 0;
  for (const f of files) {
    const ms = parseIsoMs(f.lastSync);
    if (ms !== undefined && ms > newest) {
      newest = ms;
    }
  }
  if (newest === 0) {
    return {
      level: "noData",
      summaryLines: ["Нет валидной даты lastSync у отслеживаемых файлов"],
    };
  }

  const ageMs = Date.now() - newest;

  if (ageMs >= STALE_OK_MAX_MS) {
    const days = ageMs / DAY_MS;
    return {
      level: "staleDeep",
      summaryLines: [`Последняя синхронизация ${days.toFixed(1)} дн. назад (> 14 дн.)`],
    };
  }
  if (ageMs >= RECENT_MAX_MS) {
    const days = ageMs / DAY_MS;
    return {
      level: "staleOk",
      summaryLines: [`Последняя синхронизация ${days.toFixed(1)} дн. назад (≥ 48 ч)`],
    };
  }
  if (ageMs >= FRESH_MAX_MS) {
    const hours = ageMs / HOUR_MS;
    return {
      level: "recent",
      summaryLines: [`Синхронизировался ${hours.toFixed(1)} ч. назад (≥ 12 ч)`],
    };
  }
  return {
    level: "fresh",
    summaryLines: [`Синхронизировался ${(ageMs / HOUR_MS).toFixed(1)} ч. назад (< 12 ч)`],
  };
}

/**
 * Coarse emoji for textual reports (Health Check output, info messages).
 * All four green shades share 🟢 — the precise shade is conveyed via
 * `workspaceHealthThemeColor` on the tree's cloud icon.
 */
export function workspaceHealthEmoji(level: WorkspaceHealthLevel): string {
  switch (level) {
    case "conflict":
      return "🔴";
    case "editing":
      return "🟡";
    case "noData":
      return "🔵";
    case "staleDeep":
    case "staleOk":
    case "recent":
    case "fresh":
      return "🟢";
    default: {
      const _e: never = level;
      return _e;
    }
  }
}

/**
 * Maps health level to the `contributes.colors` id used to tint the
 * tree's cloud icon. Pure string mapping — kept here so unit tests can
 * verify it without pulling in the `vscode` runtime. The actual
 * `ThemeColor` instance is constructed by the thin wrapper in
 * `workspaceHealthThemeColor.ts`.
 */
export function workspaceHealthColorId(level: WorkspaceHealthLevel): string {
  switch (level) {
    case "conflict":
      return "vscodeSync.health.conflict";
    case "editing":
      return "vscodeSync.health.editing";
    case "noData":
      return "vscodeSync.health.noData";
    case "staleDeep":
      return "vscodeSync.health.staleDeep";
    case "staleOk":
      return "vscodeSync.health.staleOk";
    case "recent":
      return "vscodeSync.health.recent";
    case "fresh":
      return "vscodeSync.health.fresh";
    default: {
      const _e: never = level;
      return _e;
    }
  }
}
