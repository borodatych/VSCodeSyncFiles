import type { CloudManifest, ManifestFile } from "./cloudLayout.js";
import { sharedIgnorePatternsOrEmpty } from "./cloudLayout.js";

function maxVersion(a: ManifestFile, b: ManifestFile): ManifestFile {
  if (a.version > b.version) {
    return a;
  }
  if (b.version > a.version) {
    return b;
  }
  return a.addedAt >= b.addedAt ? a : b;
}

/** Объединяет файловые записи по path; при конфликте — больший version, tiebreaker updatedAt. */
export function mergeManifestFiles(local: ManifestFile[], remote: ManifestFile[]): ManifestFile[] {
  const byPath = new Map<string, ManifestFile>();
  const upsert = (f: ManifestFile) => {
    const key = f.path;
    const prev = byPath.get(key);
    if (!prev) {
      byPath.set(key, { ...f });
      return;
    }
    const winner = maxVersion(prev, f);
    if (winner === f && winner !== prev) {
      byPath.set(key, { ...winner });
    }
  };
  for (const f of remote) {
    upsert(f);
  }
  for (const f of local) {
    upsert(f);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function mergeCloudManifests(local: CloudManifest, remote: CloudManifest): CloudManifest {
  if (local.workspaceId !== remote.workspaceId) {
    throw new Error("mergeCloudManifests: workspaceId mismatch");
  }
  const now = new Date().toISOString();
  const newerRemote = remote.updatedAt >= local.updatedAt;
  return {
    ...remote,
    workspaceNote: newerRemote ? remote.workspaceNote : local.workspaceNote,
    tags: [...new Set([...remote.tags, ...local.tags])],
    gitBranch: newerRemote ? remote.gitBranch ?? local.gitBranch : local.gitBranch ?? remote.gitBranch,
    sharedIgnorePatterns: [
      ...new Set([...sharedIgnorePatternsOrEmpty(remote), ...sharedIgnorePatternsOrEmpty(local)]),
    ],
    updatedAt: now,
    machines: mergeMachinesPreferNewer(local.machines, remote.machines),
    files: mergeManifestFiles(local.files, remote.files),
  };
}

/** Union machine rows by machineId — newer lastSeen wins. */
export function mergeMachinesPreferNewer(
  local: CloudManifest["machines"],
  remote: CloudManifest["machines"],
): CloudManifest["machines"] {
  const byId = new Map<string, CloudManifest["machines"][number]>();
  for (const m of remote) {
    byId.set(m.machineId, { ...m });
  }
  for (const m of local) {
    const prev = byId.get(m.machineId);
    if (!prev || m.lastSeen > prev.lastSeen) {
      byId.set(m.machineId, { ...m });
    }
  }
  return [...byId.values()];
}
