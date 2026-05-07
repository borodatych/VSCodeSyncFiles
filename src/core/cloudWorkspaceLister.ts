/**
 * Listing utility for cloud-side workspaces — used by the "Export to folder"
 * and "Restore from cloud" wizards where we need to enumerate workspaces
 * even before any local attach exists.
 *
 * Touches the cloud (provider.listFolder + downloadFile per manifest), so it's
 * intentionally placed in core/ — it's used by UI commands but doesn't import
 * vscode.
 */

import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { CLOUD_ROOT_DIR, manifestCloudPath } from "./cloudLayout.js";
import { parseManifestSafe } from "./manifestValidate.js";

export interface CloudWorkspaceSummary {
  workspaceId: string;
  workspaceNote: string;
  fileCount: number;
}

export async function listCloudWorkspacesViaPaths(
  provider: ICloudProvider,
): Promise<CloudWorkspaceSummary[]> {
  let entries: Awaited<ReturnType<ICloudProvider["listFolder"]>>;
  try {
    entries = await provider.listFolder(CLOUD_ROOT_DIR);
  } catch {
    return [];
  }
  const summaries: CloudWorkspaceSummary[] = [];
  for (const entry of entries) {
    // Heuristic: the workspaceId folders sit at the cloud root and have undefined size
    // (the provider list APIs report size only for files). Skip global JSON files
    // that are siblings (`_machines.json`) or single-shot transfer dirs (`_quicktransfer`).
    if (entry.size !== undefined) continue;
    const name = entry.cloudPath.split("/").pop() ?? "";
    if (!name || name.startsWith("_")) continue;
    const workspaceId = name;
    try {
      const dl = await provider.downloadFile(manifestCloudPath(workspaceId));
      const parsed = parseManifestSafe(dl.body);
      if (!parsed.ok) continue;
      const fileCount = parsed.value.files.filter((f) => !f.removedAt).length;
      summaries.push({
        workspaceId,
        workspaceNote: parsed.value.workspaceNote,
        fileCount,
      });
    } catch {
      // Manifest absent / not readable — skip silently. The folder may belong to
      // a workspace deleted by another machine or to an in-progress upload.
    }
  }
  summaries.sort((a, b) => a.workspaceNote.localeCompare(b.workspaceNote));
  return summaries;
}
