import type { WorkspaceConfig } from "../core/types.js";

export type WorkspaceHealthLevel = "green" | "yellow" | "red";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

function parseIsoMs(s: string): number | undefined {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Локальная оценка здоровья workspace по `vscodesync.json` (без запросов к облаку).
 * Совпадает с метриками, которые дополняют команду Health Check (конфликты, давность lastSync).
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
    return { level: "red", summaryLines: lines };
  }

  // Check for stale soft locks (editingBy set but editingSince older than threshold)
  const staleLocked = files.filter((f) => f.editingBy);
  if (staleLocked.length > 0) {
    const names = staleLocked.slice(0, 3).map((f) => `${f.localPath} (✏️ ${f.editingByName ?? f.editingBy ?? "?"} редактирует)`);
    return {
      level: "yellow",
      summaryLines: names,
    };
  }

  if (files.length === 0) {
    return { level: "green", summaryLines: ["Нет отслеживаемых файлов"] };
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
      level: "yellow",
      summaryLines: ["Нет валидной даты lastSync у отслеживаемых файлов"],
    };
  }

  const ageMs = Date.now() - newest;
  const days = ageMs / DAY_MS;

  if (days > 7) {
    return {
      level: "red",
      summaryLines: [`Последняя синхронизация > 7 дн. (${days.toFixed(1)} дн.)`],
    };
  }
  if (ageMs >= 24 * HOUR_MS) {
    return {
      level: "yellow",
      summaryLines: [`Последняя синхронизация ${days.toFixed(1)} дн. назад (≥24 ч)`],
    };
  }

  return {
    level: "green",
    summaryLines: [`Синхронизировался ${(ageMs / HOUR_MS).toFixed(1)} ч. назад (<24 ч)`],
  };
}

export function workspaceHealthEmoji(level: WorkspaceHealthLevel): string {
  switch (level) {
    case "green":
      return "🟢";
    case "yellow":
      return "🟡";
    case "red":
      return "🔴";
    default: {
      const _e: never = level;
      return _e;
    }
  }
}
