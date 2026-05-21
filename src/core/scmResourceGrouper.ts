/**
 * v0.16 N01 — pure grouping for the SCM-style "Source Control" view.
 *
 * VS Code's `SourceControlResourceGroup` accepts a flat list of files
 * per logical bucket. This module decides the buckets from `cfg.files`
 * sync statuses + autoSyncMode so the view shows the same picture
 * as the Workspaces tree.
 */

import type { TrackedFile } from "./types.js";

export type ScmBucketId =
  | "pending_push"
  | "cloud_newer"
  | "conflict"
  | "soft_locked"
  | "ok_recent";

export interface ScmGroup {
  id: ScmBucketId;
  label: string;
  files: TrackedFile[];
  /** UI hint: error / warning / info — maps to ThemeColor. */
  severity: "error" | "warn" | "info" | "ok";
}

export interface ScmGroupingOptions {
  /** Include "ok_recent" group with up to N most recently synced files. Default 0. */
  okRecentCount?: number;
}

export function groupTrackedFilesForScm(
  files: readonly TrackedFile[],
  opts: ScmGroupingOptions = {},
): ScmGroup[] {
  const conflict: TrackedFile[] = [];
  const pendingPush: TrackedFile[] = [];
  const cloudNewer: TrackedFile[] = [];
  const softLocked: TrackedFile[] = [];
  const oks: TrackedFile[] = [];

  for (const f of files) {
    if (f.editingBy) {
      softLocked.push(f);
      continue;
    }
    switch (f.syncStatus) {
      case "conflict":
        conflict.push(f);
        break;
      case "pending_push":
        pendingPush.push(f);
        break;
      case "cloud_newer":
        cloudNewer.push(f);
        break;
      default:
        oks.push(f);
    }
  }

  const out: ScmGroup[] = [];
  if (conflict.length > 0) {
    out.push({
      id: "conflict",
      label: `Conflicts (${String(conflict.length)})`,
      files: conflict,
      severity: "error",
    });
  }
  if (pendingPush.length > 0) {
    out.push({
      id: "pending_push",
      label: `Pending Push (${String(pendingPush.length)})`,
      files: pendingPush,
      severity: "warn",
    });
  }
  if (cloudNewer.length > 0) {
    out.push({
      id: "cloud_newer",
      label: `Cloud Newer (${String(cloudNewer.length)})`,
      files: cloudNewer,
      severity: "info",
    });
  }
  if (softLocked.length > 0) {
    out.push({
      id: "soft_locked",
      label: `Editing on Other Machine (${String(softLocked.length)})`,
      files: softLocked,
      severity: "info",
    });
  }
  const okRecentCount = Math.max(0, opts.okRecentCount ?? 0);
  if (okRecentCount > 0 && oks.length > 0) {
    const recent = oks
      .slice()
      .sort((a, b) => b.lastSync.localeCompare(a.lastSync))
      .slice(0, okRecentCount);
    out.push({
      id: "ok_recent",
      label: `Recent (${String(recent.length)})`,
      files: recent,
      severity: "ok",
    });
  }
  return out;
}
