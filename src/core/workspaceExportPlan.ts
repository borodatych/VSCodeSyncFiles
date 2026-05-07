/**
 * Pure planner for "Workspace Export-to-Folder". Given a manifest, produce
 * the list of files that should be exported (active, non-removed) and the
 * target absolute paths under a chosen output root. No I/O — the wrapper
 * downloads each file via the existing provider interface and writes it.
 */

import type { CloudManifest } from "./cloudLayout.js";
import * as path from "node:path";

export interface ExportPlanEntry {
  /** POSIX path inside the manifest. */
  posixRel: string;
  /** Absolute target path under `outputRoot`, OS-correct separators. */
  targetAbs: string;
}

export interface ExportPlan {
  workspaceId: string;
  outputRoot: string;
  entries: ExportPlanEntry[];
  /** True if the manifest had no exportable files. */
  empty: boolean;
}

export function planWorkspaceExport(
  manifest: CloudManifest,
  outputRoot: string,
): ExportPlan {
  const entries: ExportPlanEntry[] = [];
  for (const f of manifest.files) {
    if (f.removedAt) continue;
    const segments = f.path.split("/").filter((s) => s.length > 0 && s !== "..");
    if (segments.length === 0) continue;
    const targetAbs = path.join(outputRoot, ...segments);
    entries.push({ posixRel: f.path, targetAbs });
  }
  entries.sort((a, b) => a.posixRel.localeCompare(b.posixRel));
  return {
    workspaceId: manifest.workspaceId,
    outputRoot,
    entries,
    empty: entries.length === 0,
  };
}

/**
 * Validation: every target path must stay within `outputRoot`. Returns
 * paths that try to escape (`..` traversal etc) — caller should refuse the
 * export when this list is non-empty.
 */
export function escapingPaths(plan: ExportPlan): string[] {
  const root = path.resolve(plan.outputRoot);
  const escapes: string[] = [];
  for (const e of plan.entries) {
    const resolved = path.resolve(e.targetAbs);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      escapes.push(e.posixRel);
    }
  }
  return escapes;
}
