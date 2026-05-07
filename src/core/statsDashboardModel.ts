import type { ActivityEvent } from "./activityLog.js";
import type { StatsFileV1 } from "./syncStatsStore.js";
import { rolloverTrafficIfNeeded } from "./syncStatsStore.js";

export interface StatsDashboardPayload {
  filesSyncedWeek: number;
  filesSyncedMonth: number;
  pushCountWeek: number;
  pullCountWeek: number;
  pushCountMonth: number;
  pullCountMonth: number;
  pushPullByMachine: { machine: string; push: number; pull: number }[];
  topFiles: { path: string; count: number }[];
  /** Last 30 calendar days from “today” (local), ISO date keys. */
  dailyCounts: { date: string; count: number }[];
  conflictsResolvedWeek: number;
  conflictsResolvedMonth: number;
  bytesUploadedMonth: number;
  bytesDownloadedMonth: number;
  bytesCompressionSavedMonth: number;
  trafficMonthKey: string;
  monthlyLimitMB: number;
  compressUploadsEnabled: boolean;
}

const MS_DAY = 86_400_000;

function parseIsoMs(at: string): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

function isoDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(y)}-${m}-${day}`;
}

/**
 * Агрегаты из журнала активности + счётчики трафика из stats.json.
 * Окна: **скользящие** 7 и 30 суток от текущего момента.
 */
export function buildStatsDashboardPayload(
  events: ActivityEvent[],
  stats: StatsFileV1,
  opts: { monthlyLimitMB: number; compressUploads: boolean },
): StatsDashboardPayload {
  const now = Date.now();
  const weekAgo = now - 7 * MS_DAY;
  const monthAgo = now - 30 * MS_DAY;

  const inRange = (t: number, start: number): boolean => t >= start;

  let filesSyncedWeek = 0;
  let filesSyncedMonth = 0;
  let pushWeek = 0;
  let pullWeek = 0;
  let pushMonth = 0;
  let pullMonth = 0;
  const machineMap = new Map<string, { push: number; pull: number }>();
  const fileCounts = new Map<string, number>();
  let resolvedWeek = 0;
  let resolvedMonth = 0;
  const daily = new Map<string, number>();

  for (const e of events) {
    const t = parseIsoMs(e.at);
    if (t <= 0) {
      continue;
    }
    const { kind } = e;
    const syncOp = kind === "push" || kind === "pull" || kind === "add";
    const resolved = kind === "resolve_keep_mine" || kind === "resolve_take_theirs";

    if (syncOp && inRange(t, weekAgo)) {
      filesSyncedWeek += 1;
    }
    if (syncOp && inRange(t, monthAgo)) {
      filesSyncedMonth += 1;
    }

    if (kind === "push" && inRange(t, weekAgo)) {
      pushWeek += 1;
    }
    if (kind === "pull" && inRange(t, weekAgo)) {
      pullWeek += 1;
    }
    if (kind === "push" && inRange(t, monthAgo)) {
      pushMonth += 1;
    }
    if (kind === "pull" && inRange(t, monthAgo)) {
      pullMonth += 1;
    }

    if ((kind === "push" || kind === "pull") && inRange(t, monthAgo)) {
      const ent = machineMap.get(e.machineName) ?? { push: 0, pull: 0 };
      if (kind === "push") {
        ent.push += 1;
      } else {
        ent.pull += 1;
      }
      machineMap.set(e.machineName, ent);
    }

    if (syncOp && inRange(t, monthAgo)) {
      fileCounts.set(e.relPath, (fileCounts.get(e.relPath) ?? 0) + 1);
    }

    if (resolved && inRange(t, weekAgo)) {
      resolvedWeek += 1;
    }
    if (resolved && inRange(t, monthAgo)) {
      resolvedMonth += 1;
    }

    if (inRange(t, monthAgo)) {
      const dayKey = isoDateLocal(new Date(t));
      daily.set(dayKey, (daily.get(dayKey) ?? 0) + 1);
    }
  }

  const dailyCounts: { date: string; count: number }[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(now - i * MS_DAY);
    const date = isoDateLocal(d);
    dailyCounts.push({ date, count: daily.get(date) ?? 0 });
  }

  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([path, count]) => ({ path, count }));

  const pushPullByMachine = [...machineMap.entries()]
    .map(([machine, v]) => ({ machine, push: v.push, pull: v.pull }))
    .sort((a, b) => b.push + b.pull - (a.push + a.pull));

  const rolled = rolloverTrafficIfNeeded(stats);

  return {
    filesSyncedWeek,
    filesSyncedMonth,
    pushCountWeek: pushWeek,
    pullCountWeek: pullWeek,
    pushCountMonth: pushMonth,
    pullCountMonth: pullMonth,
    pushPullByMachine,
    topFiles,
    dailyCounts,
    conflictsResolvedWeek: resolvedWeek,
    conflictsResolvedMonth: resolvedMonth,
    bytesUploadedMonth: rolled.bytesUploadedMonth,
    bytesDownloadedMonth: rolled.bytesDownloadedMonth,
    bytesCompressionSavedMonth: rolled.bytesSavedByCompressionMonth,
    trafficMonthKey: rolled.trafficMonthKey,
    monthlyLimitMB: opts.monthlyLimitMB,
    compressUploadsEnabled: opts.compressUploads,
  };
}
