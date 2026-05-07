/**
 * Scheduled snapshots — daily / weekly point-in-time snapshot of every active
 * workspace. Lightweight: no cron lib, just `daily HH:MM` / `weekly DOW HH:MM`
 * parser + a 5-minute polling timer that decides whether the next due moment
 * has been crossed.
 *
 * Setting: `vscodesync.snapshotSchedule`
 *   `""`            — disabled (default)
 *   `"daily 03:00"` — every day at 03:00 local time
 *   `"weekly mon 03:00"` — every Monday at 03:00 local time
 */
import * as vscode from "vscode";
import { warnLog, verboseLog } from "../utils/log.js";

const STATE_KEY = "vscodesync.scheduledSnapshot.lastFiredMs";
const POLL_INTERVAL_MS = 5 * 60_000; // 5 min — far below the 1-minute granularity needed

const DAY_NAMES: readonly string[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface ParsedSchedule {
  kind: "daily" | "weekly";
  /** Target weekday (0–6, Sun..Sat); only for `weekly`. */
  weekday?: number;
  /** Target hour 0–23. */
  hour: number;
  /** Target minute 0–59. */
  minute: number;
}

export function parseSnapshotSchedule(raw: string): ParsedSchedule | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // daily HH:MM
  const daily = /^daily\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (daily) {
    const h = Number(daily[1]);
    const m = Number(daily[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { kind: "daily", hour: h, minute: m };
  }
  // weekly DOW HH:MM
  const weekly = /^weekly\s+([a-z]{3})\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (weekly) {
    const dow = DAY_NAMES.indexOf(weekly[1]);
    if (dow < 0) return null;
    const h = Number(weekly[2]);
    const m = Number(weekly[3]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { kind: "weekly", weekday: dow, hour: h, minute: m };
  }
  return null;
}

/** Compute the most recent firing instant in the past (ms epoch) for a schedule. */
export function lastDueInstant(
  schedule: ParsedSchedule,
  now = new Date(),
): number {
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setHours(schedule.hour, schedule.minute);
  if (schedule.kind === "daily") {
    if (candidate.getTime() > now.getTime()) {
      candidate.setDate(candidate.getDate() - 1);
    }
    return candidate.getTime();
  }
  // weekly
  const targetDow = schedule.weekday ?? 0;
  const dayDiff = (now.getDay() - targetDow + 7) % 7;
  candidate.setDate(candidate.getDate() - dayDiff);
  if (candidate.getTime() > now.getTime()) {
    candidate.setDate(candidate.getDate() - 7);
  }
  return candidate.getTime();
}

export interface ScheduledSnapshotsDeps {
  /** Folder roots that are eligible for snapshotting (one per workspace folder). */
  getCandidateFolders: () => readonly { uri: vscode.Uri }[];
  /** Trigger a snapshot for every active workspace under `folderRoot`. Caller decides batching. */
  snapshotFolder: (folderRoot: string) => Promise<void>;
}

export function registerScheduledSnapshots(
  context: vscode.ExtensionContext,
  deps: ScheduledSnapshotsDeps,
): void {
  const tick = async (): Promise<void> => {
    const raw = vscode.workspace
      .getConfiguration("vscodesync")
      .get<string>("snapshotSchedule", "");
    const schedule = parseSnapshotSchedule(raw);
    if (!schedule) return;

    const due = lastDueInstant(schedule);
    const lastFired = context.globalState.get<number>(STATE_KEY) ?? 0;
    if (lastFired >= due) return; // already snapshotted past this moment

    verboseLog("snapshotSchedule", `firing for due=${new Date(due).toISOString()}`);
    const folders = deps.getCandidateFolders();
    let any = false;
    for (const f of folders) {
      try {
        await deps.snapshotFolder(f.uri.fsPath);
        any = true;
      } catch (e: unknown) {
        warnLog(
          "snapshotSchedule",
          `snapshot failed for ${f.uri.fsPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    await context.globalState.update(STATE_KEY, due);
    if (any) {
      void vscode.window.showInformationMessage(
        `VSCodeSync: запланированные снапшоты созданы (${schedule.kind} ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}).`,
      );
    }
  };

  // Initial tick once after startup, then every 5 minutes.
  const initialTimer = setTimeout(() => { void tick(); }, 30_000);
  const intervalTimer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => { clearTimeout(initialTimer); }),
    new vscode.Disposable(() => { clearInterval(intervalTimer); }),
  );
}
