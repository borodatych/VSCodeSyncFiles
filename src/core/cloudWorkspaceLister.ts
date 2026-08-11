/**
 * Listing utility for cloud-side workspaces — used by the "Export to folder"
 * and "Restore from cloud" wizards where we need to enumerate workspaces
 * even before any local attach exists.
 *
 * Touches the cloud (provider.listFolder + downloadFile per manifest), so it's
 * intentionally placed in core/ — it's used by UI commands but doesn't import
 * vscode.
 */

import type { FileMetadata, ICloudProvider } from "../providers/cloudProviderTypes.js";
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

/**
 * Direct child folder ids of the cloud root from a flat listing. Extracted
 * verbatim from `syncEngine.ts` (engine line-ceiling offset for Link
 * Bindings). Handles providers that return full disk paths (Yandex app
 * folder) by locating the root marker inside the path.
 */
export function directChildFolderIds(cloudRoot: string, items: FileMetadata[]): string[] {
  const base = cloudRoot.endsWith("/") ? cloudRoot : `${cloudRoot}/`;
  const ids = new Set<string>();
  for (const it of items) {
    let rest: string | undefined;
    if (it.cloudPath.startsWith(base)) {
      rest = it.cloudPath.slice(base.length);
    } else {
      // app folder: Yandex returns full disk path, e.g. "Приложения/App/VSCodeSyncFiles/id"
      const markerIdx = it.cloudPath.indexOf(base);
      if (markerIdx >= 0) {
        rest = it.cloudPath.slice(markerIdx + base.length);
      }
    }
    if (rest === undefined) {
      continue;
    }
    const seg = rest.split("/")[0];
    if (!seg || seg.includes(".")) {
      continue;
    }
    ids.add(seg);
  }
  return [...ids];
}

/**
 * Remote workspace summaries via manifest probes (extracted verbatim from
 * `syncEngine.listRemoteWorkspaceSummaries` — engine line-ceiling offset for
 * Link Bindings). Skips folders whose manifest is unreadable, has a foreign
 * schemaVersion or a mismatched workspaceId.
 */
export async function listRemoteWorkspaceSummaries(
  provider: ICloudProvider,
  supportedSchema: number,
): Promise<{ workspaceId: string; workspaceNote: string }[]> {
  const listed = await provider.listFolder(CLOUD_ROOT_DIR);
  const candidates = directChildFolderIds(CLOUD_ROOT_DIR, listed);
  const out: { workspaceId: string; workspaceNote: string }[] = [];
  for (const id of candidates) {
    try {
      const dl = await provider.downloadFile(manifestCloudPath(id));
      const m = JSON.parse(dl.body.toString("utf8")) as {
        schemaVersion?: number;
        workspaceId?: string;
        workspaceNote?: string;
      };
      if (m.schemaVersion !== supportedSchema) {
        continue;
      }
      if (m.workspaceId !== id) {
        continue;
      }
      out.push({ workspaceId: id, workspaceNote: m.workspaceNote ?? id });
    } catch {
      /* не workspace */
    }
  }
  out.sort((a, b) => a.workspaceNote.localeCompare(b.workspaceNote, undefined, { sensitivity: "base" }));
  return out;
}
