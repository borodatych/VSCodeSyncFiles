/**
 * Toast-on-match for Activity Feed saved searches.
 *
 * Each saved filter can be opted in for desktop alerts via
 * `vscodesync.activity.alertingFilters` (array of saved-search IDs in
 * globalState). When a new ActivityEvent matches any opted-in filter, a
 * non-modal information toast is shown — at most one toast per `BATCH_MS`
 * to avoid spamming during bulk syncs.
 */
import * as vscode from "vscode";
import type { ActivityEventInput } from "../core/activityLog.js";
import { listSavedSearches } from "./activitySavedSearches.js";
import { eventMatchesFilter } from "./activityFilterMatch.js";

export { eventMatchesFilter } from "./activityFilterMatch.js";

const ALERTING_KEY = "vscodesync.activity.alertingFilterIds";
const BATCH_MS = 4_000;

export function listAlertingFilterIds(context: vscode.ExtensionContext): string[] {
  const raw = context.globalState.get<unknown>(ALERTING_KEY);
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

export async function setAlertingFilterIds(
  context: vscode.ExtensionContext,
  ids: readonly string[],
): Promise<void> {
  await context.globalState.update(ALERTING_KEY, [...new Set(ids)]);
}

interface PendingMatch {
  filterName: string;
  count: number;
  sampleRel: string;
}

export class ActivityAlertMonitor implements vscode.Disposable {
  private pending = new Map<string, PendingMatch>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Call from the existing activity hook on every new event. */
  notify(ev: ActivityEventInput): void {
    if (this.disposed) return;
    const alerting = listAlertingFilterIds(this.context);
    if (alerting.length === 0) return;
    const all = listSavedSearches(this.context);
    for (const id of alerting) {
      const found = all.find((s) => s.id === id);
      if (!found) continue;
      if (!eventMatchesFilter(ev, found.filter)) continue;
      const cur = this.pending.get(id);
      if (cur) {
        cur.count += 1;
      } else {
        this.pending.set(id, { filterName: found.name, count: 1, sampleRel: ev.relPath });
      }
    }
    if (this.pending.size > 0 && this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => { this.flush(); }, BATCH_MS);
    }
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (this.disposed) return;
    for (const m of this.pending.values()) {
      const text = m.count === 1
        ? `VSCodeSync · «${m.filterName}»: ${m.sampleRel}`
        : `VSCodeSync · «${m.filterName}»: ${String(m.count)} событий (последнее: ${m.sampleRel})`;
      void vscode.window.showInformationMessage(text, "Open Activity").then((choice) => {
        // Capture `disposed` *after* the dialog resolves — extension may
        // have deactivated while the toast was open.
        if (this.disposed) return;
        if (choice === "Open Activity") {
          void vscode.commands.executeCommand("vscodesync.openActivityFeed");
        }
      });
    }
    this.pending.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pending.clear();
  }
}
