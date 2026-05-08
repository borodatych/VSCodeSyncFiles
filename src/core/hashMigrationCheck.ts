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
