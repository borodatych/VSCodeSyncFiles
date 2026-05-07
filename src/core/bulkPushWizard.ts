/**
 * Bulk Push Wizard — pure planner + result formatter.
 *
 * The actual push runs via `engine.pushAll(_, onProgress)` (declared in
 * `syncEngine.ts`); the UI command in `extension.ts` wires the planner
 * output through a QuickPick + `vscode.window.withProgress`.
 */
import type { PushAllResult } from "./syncEngine.js";

export interface BulkPushTarget {
  workspaceId: string;
  workspaceNote: string;
  pendingFileCount: number;
}

export interface BulkPushPlan {
  totalWorkspaces: number;
  totalPendingFiles: number;
  targets: BulkPushTarget[];
}

export function planBulkPush(targets: readonly BulkPushTarget[]): BulkPushPlan {
  const filtered = targets.filter((t) => t.pendingFileCount > 0);
  const totalPendingFiles = filtered.reduce((sum, t) => sum + t.pendingFileCount, 0);
  filtered.sort(
    (a, b) =>
      b.pendingFileCount - a.pendingFileCount ||
      a.workspaceNote.localeCompare(b.workspaceNote) ||
      a.workspaceId.localeCompare(b.workspaceId),
  );
  return {
    totalWorkspaces: filtered.length,
    totalPendingFiles,
    targets: filtered,
  };
}

export interface BulkPushSummary {
  okCount: number;
  failCount: number;
  totalPushed: number;
  failedWorkspaceIds: string[];
}

export function summariseBulkPushResults(results: readonly PushAllResult[]): BulkPushSummary {
  let okCount = 0;
  let failCount = 0;
  let totalPushed = 0;
  const failedWorkspaceIds: string[] = [];
  for (const r of results) {
    if (r.ok) {
      okCount++;
    } else {
      failCount++;
      failedWorkspaceIds.push(r.workspaceId);
    }
    totalPushed += r.pushedFiles;
  }
  return { okCount, failCount, totalPushed, failedWorkspaceIds };
}

export function formatBulkPushResults(results: readonly PushAllResult[]): string {
  const s = summariseBulkPushResults(results);
  const lines: string[] = [];
  lines.push(`VSCodeSync · Bulk Push — ${String(s.okCount)} ok / ${String(s.failCount)} failed`);
  lines.push(`Pushed ${String(s.totalPushed)} file(s) across ${String(results.length)} workspace(s).`);
  if (s.failCount === 0) return lines.join("\n");
  lines.push("");
  lines.push("Failures:");
  for (const r of results) {
    if (r.ok) continue;
    lines.push(`  ✗ ${r.workspaceId}: ${r.error ?? "(no error message)"}`);
  }
  return lines.join("\n");
}
