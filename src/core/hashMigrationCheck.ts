/**
 * v2.3.3 — pure helper that summarises whether a workspace's `_meta.json` is
 * ready to switch from `sha256` / `dual` to `blake3`-only.
 *
 * Inputs: a list of MetaEntry-shaped records (we read only the fields we
 * need). Outputs: per-workspace ratios + boolean `safeToSwitchToBlake3`.
 *
 * The actual reading of `_meta.json` blobs is the caller's responsibility —
 * this module is vscode-free and provider-free.
 */

export interface HashMigrationMetaEntry {
  /** Workspace-relative POSIX path (used by the migration task planner). */
  relPath?: string;
  /** sha256 lowercase hex (always present, even on legacy entries). */
  hash: string;
  /** blake3 lowercase hex; only present after the workspace ran on
   * canonicalHashAlgo === "dual" or "blake3". */
  hashBlake3?: string;
}

export interface HashMigrationWorkspaceReport {
  workspaceId: string;
  totalEntries: number;
  withBlake3: number;
  withoutBlake3: number;
  ratioWithBlake3: number;
  /** True iff every entry has a BLAKE3 hash — the workspace is safe to flip
   * setting to "blake3"-only. */
  safeToSwitchToBlake3: boolean;
}

export interface HashMigrationGlobalReport {
  perWorkspace: HashMigrationWorkspaceReport[];
  totalWorkspaces: number;
  totalEntries: number;
  totalWithBlake3: number;
  ratioWithBlake3: number;
  /** True iff every workspace is safe to flip. Caller should still confirm
   * with the user before switching. */
  safeToSwitchToBlake3: boolean;
}

export function runHashAlgoMigrationCheck(
  workspaces: { workspaceId: string; entries: HashMigrationMetaEntry[] }[],
): HashMigrationGlobalReport {
  const perWorkspace: HashMigrationWorkspaceReport[] = [];
  let totalEntries = 0;
  let totalWithBlake3 = 0;

  for (const ws of workspaces) {
    let withBlake3 = 0;
    for (const e of ws.entries) {
      if (e.hashBlake3 !== undefined && /^[0-9a-f]{64}$/.test(e.hashBlake3)) withBlake3 += 1;
    }
    const totalForWs = ws.entries.length;
    const withoutBlake3 = totalForWs - withBlake3;
    const ratio = totalForWs === 0 ? 1 : withBlake3 / totalForWs;
    perWorkspace.push({
      workspaceId: ws.workspaceId,
      totalEntries: totalForWs,
      withBlake3,
      withoutBlake3,
      ratioWithBlake3: ratio,
      safeToSwitchToBlake3: withoutBlake3 === 0,
    });
    totalEntries += totalForWs;
    totalWithBlake3 += withBlake3;
  }

  return {
    perWorkspace,
    totalWorkspaces: perWorkspace.length,
    totalEntries,
    totalWithBlake3,
    ratioWithBlake3: totalEntries === 0 ? 1 : totalWithBlake3 / totalEntries,
    safeToSwitchToBlake3: perWorkspace.every((ws) => ws.safeToSwitchToBlake3),
  };
}

/**
 * v2.3.4 — task planner for the `vscodesync.completeBlake3Migration`
 * background command. Walks the same workspace inventory used by
 * `runHashAlgoMigrationCheck` and emits a flat, deterministic list of
 * `(workspaceId, relPath)` tuples that still need BLAKE3 backfill.
 *
 * The command itself iterates the returned tasks, recomputes BLAKE3 over the
 * local file (no download needed — local hash is canonical), then writes the
 * updated `MetaEntry` back to `_meta.json` via the engine's pushFile path
 * with `wireZstd`/`wireGzip` flags untouched.
 */
export interface Blake3MigrationTask {
  workspaceId: string;
  relPath: string;
  /** Existing sha256 — kept for the meta entry merge. */
  existingSha256: string;
}

export interface Blake3MigrationPlan {
  tasks: Blake3MigrationTask[];
  totalTasks: number;
  /** Workspaces that contributed at least one task. */
  affectedWorkspaceIds: string[];
}

export function planBlake3MigrationTasks(
  workspaces: { workspaceId: string; entries: HashMigrationMetaEntry[] }[],
): Blake3MigrationPlan {
  const tasks: Blake3MigrationTask[] = [];
  const affected = new Set<string>();

  for (const ws of workspaces) {
    for (const e of ws.entries) {
      if (e.hashBlake3 !== undefined && /^[0-9a-f]{64}$/.test(e.hashBlake3)) continue;
      if (e.relPath === undefined || e.relPath.length === 0) continue; // skip legacy entries without path
      tasks.push({
        workspaceId: ws.workspaceId,
        relPath: e.relPath,
        existingSha256: e.hash,
      });
      affected.add(ws.workspaceId);
    }
  }

  // Deterministic order: workspaceId asc, then relPath asc.
  tasks.sort((a, b) =>
    a.workspaceId === b.workspaceId
      ? a.relPath.localeCompare(b.relPath)
      : a.workspaceId.localeCompare(b.workspaceId),
  );

  return {
    tasks,
    totalTasks: tasks.length,
    affectedWorkspaceIds: [...affected].sort(),
  };
}
