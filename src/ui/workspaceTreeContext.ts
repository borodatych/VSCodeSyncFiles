import type { WorkspaceSyncState } from "../core/types.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";

/**
 * Tree `contextValue` for workspace rows — menus match `vscodeSync.workspace*` / `vscodeSync.workspaceArchived*`.
 */
export function workspaceTreeContextValue(
  syncState: WorkspaceSyncState | undefined,
  tags: string[] | undefined,
): string {
  const archived = (tags ?? []).some((t) => t.trim().toLowerCase() === "archived");
  const st = normalizeWorkspaceSyncState({ syncState });
  const base = st === "frozen" ? "Frozen" : st === "suspended" ? "Suspended" : "Active";
  return archived ? `vscodeSync.workspaceArchived${base}` : `vscodeSync.workspace${base}`;
}
