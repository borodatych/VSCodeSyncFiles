/**
 * Pure activity-event matcher — vscode-free so it can be unit-tested.
 *
 * Filter semantics:
 *   - kind: exact match. `"any"` or undefined = wildcard.
 *   - workspaceId: exact match. undefined = wildcard.
 *   - query: case-insensitive substring search across
 *     workspaceNote + relPath + machineName + detail.
 *
 * All present criteria are AND-combined.
 */
import type { ActivityEventInput } from "../core/activityLog.js";

/** Local copy of the filter shape to keep this module vscode-free. */
export interface ActivityFilter {
  kind?: string;
  workspaceId?: string;
  query?: string;
}

/** Alias kept so existing imports keep working. */
export type SavedActivityFilter = ActivityFilter;

export function eventMatchesFilter(
  ev: ActivityEventInput,
  filter: SavedActivityFilter,
): boolean {
  if (filter.kind && filter.kind !== "any" && ev.kind !== filter.kind) return false;
  if (filter.workspaceId && ev.workspaceId !== filter.workspaceId) return false;
  const q = filter.query?.trim().toLowerCase();
  if (q) {
    const haystack = `${ev.workspaceNote} ${ev.relPath} ${ev.machineName} ${ev.detail ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}
