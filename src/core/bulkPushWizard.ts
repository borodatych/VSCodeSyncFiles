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

/**
 * One-line outcome for a toast.
 *
 * The commands used to announce a flat "Push …: готово." regardless of what
 * happened: zero files sent, files skipped, whole workspaces failed — all read
 * as success, which is exactly the "it says done but nothing was uploaded"
 * complaint.
 */
export function summarisePushForToast(
  label: string,
  results: readonly PushAllResult[],
): string {
  const pushed = results.reduce((n, r) => n + r.pushedFiles, 0);
  const failedWorkspaces = results.filter((r) => !r.ok).length;
  const skippedFiles = results.reduce((n, r) => n + (r.failedFiles?.length ?? 0), 0);

  const parts: string[] = [];
  parts.push(pushed > 0 ? `отправлено файлов: ${String(pushed)}` : "отправлять было нечего");
  if (skippedFiles > 0) parts.push(`пропущено файлов: ${String(skippedFiles)}`);
  if (failedWorkspaces > 0) parts.push(`ошибок в папках: ${String(failedWorkspaces)}`);
  const tail = skippedFiles > 0 || failedWorkspaces > 0 ? " Подробности — в канале Diagnostics." : "";
  return `${label}: ${parts.join(", ")}.${tail}`;
}

export function formatBulkPushResults(results: readonly PushAllResult[]): string {
  const s = summariseBulkPushResults(results);
  const lines: string[] = [];
  lines.push(`VSCodeSync · Bulk Push — ${String(s.okCount)} ok / ${String(s.failCount)} failed`);
  lines.push(`Pushed ${String(s.totalPushed)} file(s) across ${String(results.length)} workspace(s).`);
  // Per-file failures are reported even when the workspace itself succeeded:
  // one unreadable file no longer aborts the workspace, so without this line
  // the summary would claim success while some files were never sent.
  const skipped = results.flatMap((r) =>
    (r.failedFiles ?? []).map((f) => ({ workspaceId: r.workspaceId, ...f })),
  );
  if (s.failCount === 0 && skipped.length === 0) return lines.join("\n");
  if (s.failCount > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const r of results) {
      if (r.ok) continue;
      lines.push(`  ✗ ${r.workspaceId}: ${r.error ?? "(no error message)"}`);
    }
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push(`Skipped files (${String(skipped.length)}):`);
    for (const f of skipped) {
      lines.push(`  ! ${f.workspaceId} · ${f.posixRel}: ${f.error}`);
    }
  }
  return lines.join("\n");
}
