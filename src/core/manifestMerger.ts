import type { BindingEntry, CloudManifest, ManifestFile } from "./cloudLayout.js";
import { sharedIgnorePatternsOrEmpty } from "./cloudLayout.js";
import { warnLog } from "../utils/log.js";

function maxVersion(a: ManifestFile, b: ManifestFile): ManifestFile {
  if (a.version > b.version) {
    return a;
  }
  if (b.version > a.version) {
    return b;
  }
  if (a.addedAt !== b.addedAt) {
    return a.addedAt >= b.addedAt ? a : b;
  }
  if ((a.editingBy ?? "") !== (b.editingBy ?? "")) {
    // Same (version, addedAt) — concurrent inserts on different machines.
    // Stable choice preferred for determinism; surface to log for diagnosis.
    warnLog(
      "manifestMerger",
      `maxVersion tie-break path=${a.path} version=${String(a.version)} ` +
        `editingByA=${a.editingBy ?? "—"} editingByB=${b.editingBy ?? "—"}`,
    );
  }
  // Full (version, addedAt) tie: pick by linkId so both sides converge
  // regardless of merge argument order (the old `a`-wins branch was
  // order-dependent, which two v2 machines would never agree on).
  if ((a.linkId ?? "") !== (b.linkId ?? "")) {
    return (a.linkId ?? "") > (b.linkId ?? "") ? a : b;
  }
  return a;
}

/**
 * Link Bindings: per-key LWW union of the bindings maps. Row-winner precedence
 * would lose a rebind racing an unrelated row edit (soft-lock bump, linkName
 * change); newest `boundAt` per machineId keeps both. Mirrors the
 * `mergeMachinesPreferNewer` pattern.
 */
function mergeBindings(
  winner: ManifestFile["bindings"],
  loser: ManifestFile["bindings"],
): Record<string, BindingEntry> | undefined {
  if (!winner && !loser) return undefined;
  const byMachine = new Map<string, BindingEntry>();
  for (const [machineId, entry] of Object.entries(loser ?? {})) {
    byMachine.set(machineId, { ...entry });
  }
  for (const [machineId, entry] of Object.entries(winner ?? {})) {
    const prev = byMachine.get(machineId);
    if (prev === undefined || entry.boundAt >= prev.boundAt) {
      byMachine.set(machineId, { ...entry });
    }
  }
  return Object.fromEntries(byMachine);
}

/** Winner row + cross-row grafts that must survive whichever side wins. */
function mergeRow(prev: ManifestFile, next: ManifestFile): ManifestFile {
  const winner = maxVersion(prev, next);
  const loser = winner === prev ? next : prev;
  const merged: ManifestFile = { ...winner };
  // linkId graft: a v1 machine (or repair) may have rebuilt the winning row
  // without identity — the loser's id is better than a re-backfilled one.
  if (merged.linkId === undefined && loser.linkId !== undefined) {
    merged.linkId = loser.linkId;
  }
  if (merged.linkName === undefined && loser.linkName !== undefined) {
    merged.linkName = loser.linkName;
  }
  const bindings = mergeBindings(winner.bindings, loser.bindings);
  if (bindings !== undefined) {
    merged.bindings = bindings;
  }
  return merged;
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
    byPath.set(key, mergeRow(prev, f));
  };
  for (const f of remote) {
    upsert(f);
  }
  for (const f of local) {
    upsert(f);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Link Bindings: manifest-level folder rules merge as per-(machine, prefix)
 * LWW on `boundAt` — same shape as per-row `bindings`, one level deeper.
 */
function mergeFolderBindings(
  local: CloudManifest["folderBindings"],
  remote: CloudManifest["folderBindings"],
): CloudManifest["folderBindings"] {
  if (!local && !remote) return undefined;
  const out: Record<string, Record<string, BindingEntry>> = {};
  for (const source of [remote ?? {}, local ?? {}]) {
    for (const [machineId, rules] of Object.entries(source)) {
      const byPrefix = new Map<string, BindingEntry>(Object.entries(out[machineId] ?? {}));
      for (const [prefix, entry] of Object.entries(rules)) {
        const prev = byPrefix.get(prefix);
        if (prev === undefined || entry.boundAt >= prev.boundAt) {
          byPrefix.set(prefix, { ...entry });
        }
      }
      out[machineId] = Object.fromEntries(byPrefix);
    }
  }
  return out;
}

export function mergeCloudManifests(local: CloudManifest, remote: CloudManifest): CloudManifest {
  if (local.workspaceId !== remote.workspaceId) {
    throw new Error("mergeCloudManifests: workspaceId mismatch");
  }
  const now = new Date().toISOString();
  const newerRemote = remote.updatedAt >= local.updatedAt;
  const folderBindings = mergeFolderBindings(local.folderBindings, remote.folderBindings);
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
    ...(folderBindings !== undefined ? { folderBindings } : {}),
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
