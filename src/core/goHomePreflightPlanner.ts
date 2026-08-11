/**
 * F8 — pre-flight checklist for «I'm about to close the laptop» moment.
 *
 * Pure planner: takes a snapshot of tracked files across all open
 * workspaces and decides what the user should do before they leave.
 *
 * Output is consumed by the `vscodesync.goHomePreflight` UI command,
 * which renders the verdict as an info / warning / error message with
 * one-click action buttons (Push all / View conflicts / Override).
 */

export type GoHomeVerdict =
  | { kind: "clean"; trackedCount: number }
  | { kind: "pending_push"; files: string[]; total: number }
  | { kind: "cloud_newer"; files: string[]; total: number }
  | { kind: "conflict"; files: string[]; total: number }
  | { kind: "mixed"; pendingPush: number; cloudNewer: number; conflicts: number };

export interface PreflightFile {
  workspaceId: string;
  localPath: string;
  syncStatus?: string;
}

/**
 * Decide what the user needs to do before closing.
 *
 * Priority: conflict > pending_push > cloud_newer > clean.
 * Multiple categories present → `mixed`.
 */
export function planGoHomePreflight(files: PreflightFile[]): GoHomeVerdict {
  const pendingPush: string[] = [];
  const cloudNewer: string[] = [];
  const conflicts: string[] = [];
  for (const f of files) {
    if (f.syncStatus === "pending_push") pendingPush.push(f.localPath);
    else if (f.syncStatus === "cloud_newer" || f.syncStatus === "missing_local") cloudNewer.push(f.localPath);
    else if (f.syncStatus === "conflict") conflicts.push(f.localPath);
  }
  const categories = [
    pendingPush.length > 0,
    cloudNewer.length > 0,
    conflicts.length > 0,
  ].filter(Boolean).length;
  if (categories === 0) {
    return { kind: "clean", trackedCount: files.length };
  }
  if (categories >= 2) {
    return {
      kind: "mixed",
      pendingPush: pendingPush.length,
      cloudNewer: cloudNewer.length,
      conflicts: conflicts.length,
    };
  }
  if (conflicts.length > 0) {
    return { kind: "conflict", files: conflicts.slice(0, 10), total: conflicts.length };
  }
  if (pendingPush.length > 0) {
    return { kind: "pending_push", files: pendingPush.slice(0, 10), total: pendingPush.length };
  }
  return { kind: "cloud_newer", files: cloudNewer.slice(0, 10), total: cloudNewer.length };
}

/** Short human summary for status-bar / notification headline. */
export function describeGoHomeVerdict(v: GoHomeVerdict): string {
  switch (v.kind) {
    case "clean":
      return `✅ Можно закрывать. ${String(v.trackedCount)} файл(ов) синхронизировано.`;
    case "pending_push":
      return `⬆️ ${String(v.total)} файл(ов) ждут отправки в облако.`;
    case "cloud_newer":
      return `⬇️ ${String(v.total)} файл(ов) обновлено коллегами — скачать?`;
    case "conflict":
      return `⚠️ ${String(v.total)} конфликт(ов) требуют ручного решения.`;
    case "mixed":
      return (
        `Требует внимания: ↑${String(v.pendingPush)} ↓${String(v.cloudNewer)} ⚠${String(v.conflicts)}`
      );
  }
}
