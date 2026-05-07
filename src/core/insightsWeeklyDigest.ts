/**
 * Weekly Insights digest — vscode-free aggregator over ActivityEvent[].
 *
 * Produces a structured summary of the last N days of sync activity and a
 * formatted text representation for OutputChannel display.
 */
import type { ActivityEvent, ActivityKind } from "./activityLog.js";

export interface WeeklyDigestInput {
  events: readonly ActivityEvent[];
  nowMs: number;
  windowDays?: number;
}

export interface DigestCounter<K extends string> {
  key: K;
  label: string;
  count: number;
}

export interface FileCounter {
  relPath: string;
  count: number;
}

export interface MachineCounter {
  machineName: string;
  count: number;
}

export interface WorkspaceCounter {
  workspaceId: string;
  workspaceNote: string;
  count: number;
}

export interface DayCounter {
  date: string;
  count: number;
}

export interface WeeklyDigest {
  windowDays: number;
  totalEvents: number;
  byKind: Record<ActivityKind, number>;
  topFiles: FileCounter[];
  topMachines: MachineCounter[];
  topWorkspaces: WorkspaceCounter[];
  byDay: DayCounter[];
  busiestDay: DayCounter | null;
  quietestDay: DayCounter | null;
}

const TOP_FILES = 5;
const TOP_MACHINES = 5;
const TOP_WORKSPACES = 3;

export function buildWeeklyDigest(input: WeeklyDigestInput): WeeklyDigest {
  const windowDays = input.windowDays && input.windowDays > 0 ? input.windowDays : 7;
  const cutoff = input.nowMs - windowDays * 86_400_000;
  const inWindow: ActivityEvent[] = [];
  for (const ev of input.events) {
    const t = Date.parse(ev.at);
    if (!Number.isNaN(t) && t >= cutoff && t <= input.nowMs) inWindow.push(ev);
  }

  const byKind: Record<ActivityKind, number> = {
    push: 0,
    pull: 0,
    conflict: 0,
    add: 0,
    remove: 0,
    resolve_keep_mine: 0,
    resolve_take_theirs: 0,
  };
  const fileCounts = new Map<string, number>();
  const machineCounts = new Map<string, number>();
  const workspaceCounts = new Map<string, { workspaceNote: string; count: number }>();
  const dayCounts = new Map<string, number>();

  for (const ev of inWindow) {
    byKind[ev.kind] += 1;
    if (ev.relPath) fileCounts.set(ev.relPath, (fileCounts.get(ev.relPath) ?? 0) + 1);
    if (ev.machineName) machineCounts.set(ev.machineName, (machineCounts.get(ev.machineName) ?? 0) + 1);
    if (ev.workspaceId) {
      const cur = workspaceCounts.get(ev.workspaceId);
      workspaceCounts.set(ev.workspaceId, {
        workspaceNote: cur ? cur.workspaceNote : ev.workspaceNote,
        count: (cur?.count ?? 0) + 1,
      });
    }
    const day = ev.at.slice(0, 10); // yyyy-mm-dd
    if (day.length === 10) dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  const topFiles: FileCounter[] = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_FILES)
    .map(([relPath, count]) => ({ relPath, count }));
  const topMachines: MachineCounter[] = [...machineCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_MACHINES)
    .map(([machineName, count]) => ({ machineName, count }));
  const topWorkspaces: WorkspaceCounter[] = [...workspaceCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, TOP_WORKSPACES)
    .map(([workspaceId, v]) => ({ workspaceId, workspaceNote: v.workspaceNote, count: v.count }));

  // Fill the day axis end-to-start so the report always shows the full window
  // even when there were quiet days.
  const byDay: DayCounter[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const dayMs = input.nowMs - i * 86_400_000;
    const date = new Date(dayMs).toISOString().slice(0, 10);
    byDay.push({ date, count: dayCounts.get(date) ?? 0 });
  }
  let busiestDay: DayCounter | null = null;
  let quietestDay: DayCounter | null = null;
  for (const d of byDay) {
    if (busiestDay === null || d.count > busiestDay.count) busiestDay = d;
    if (quietestDay === null || d.count < quietestDay.count) quietestDay = d;
  }

  return {
    windowDays,
    totalEvents: inWindow.length,
    byKind,
    topFiles,
    topMachines,
    topWorkspaces,
    byDay,
    busiestDay,
    quietestDay,
  };
}

export function formatWeeklyDigest(d: WeeklyDigest): string {
  const lines: string[] = [];
  lines.push(`VSCodeSync — Insights (last ${String(d.windowDays)} days)`);
  lines.push("─".repeat(48));
  lines.push(`Total events: ${String(d.totalEvents)}`);
  lines.push(
    `  push=${String(d.byKind.push)} pull=${String(d.byKind.pull)} conflict=${String(d.byKind.conflict)} add=${String(d.byKind.add)} remove=${String(d.byKind.remove)}`,
  );
  lines.push(
    `  resolve_keep_mine=${String(d.byKind.resolve_keep_mine)} resolve_take_theirs=${String(d.byKind.resolve_take_theirs)}`,
  );
  lines.push("");

  lines.push("By day:");
  for (const day of d.byDay) {
    const bar = "█".repeat(Math.min(day.count, 40));
    lines.push(`  ${day.date}  ${String(day.count).padStart(4)}  ${bar}`);
  }
  if (d.busiestDay && d.busiestDay.count > 0) {
    lines.push(`  Busiest: ${d.busiestDay.date} (${String(d.busiestDay.count)} events)`);
  }
  lines.push("");

  if (d.topFiles.length > 0) {
    lines.push("Top files:");
    for (const f of d.topFiles) lines.push(`  ${String(f.count).padStart(4)}  ${f.relPath}`);
    lines.push("");
  }
  if (d.topMachines.length > 0) {
    lines.push("Top machines:");
    for (const m of d.topMachines) lines.push(`  ${String(m.count).padStart(4)}  ${m.machineName}`);
    lines.push("");
  }
  if (d.topWorkspaces.length > 0) {
    lines.push("Top workspaces:");
    for (const w of d.topWorkspaces) {
      const label = w.workspaceNote.trim().length > 0 ? w.workspaceNote : w.workspaceId;
      lines.push(`  ${String(w.count).padStart(4)}  ${label} (${w.workspaceId.slice(0, 8)})`);
    }
  }

  return lines.join("\n");
}
