import type { WorkspaceConfig } from "../core/types.js";

function parseIsoMs(s: string): number | undefined {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** Latest successful sync timestamp among tracked files for this workspace (ISO → ms). */
export function newestTrackedLastSyncMs(wc: WorkspaceConfig, workspaceId: string): number | undefined {
  let newest = 0;
  for (const f of wc.files) {
    if (f.workspaceId !== workspaceId) {
      continue;
    }
    const ms = parseIsoMs(f.lastSync);
    if (ms !== undefined && ms > newest) {
      newest = ms;
    }
  }
  return newest > 0 ? newest : undefined;
}

export function hasArchivedTag(tags: string[] | undefined): boolean {
  return (tags ?? []).some((t) => t.trim().toLowerCase() === "archived");
}
