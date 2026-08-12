/**
 * Sync scope (docs/v2/linkBindings.md): which canonical folders this machine
 * takes from a workspace.
 *
 * "Sync everything" is wrong the moment two machines lay the project out
 * differently: the home machine wants `src/SEMD272/**`, the work machine takes
 * `jscore/**` and `promed/**` and nothing else. Without a scope the rest shows
 * up as dozens of "нет на диске" rows the user never asked for.
 *
 * Scope is a LOCAL, per-machine list of canonical prefixes — the cloud has no
 * say in what this disk carries. Empty list means the whole workspace, so
 * every pre-scope config keeps working unchanged.
 *
 * Pure: strings in, verdict out.
 */

/** Normalize a prefix the way the manifest keys it: no leading/trailing slashes. */
export function normalizeScopePrefix(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}

/**
 * Is this canonical manifest key inside the scope? An empty scope admits
 * everything. A prefix matches the folder itself and anything below it, but
 * never a sibling that merely starts with the same letters (`php` ≠ `php2`).
 */
export function isInSyncScope(scopes: readonly string[] | undefined, canonicalKey: string): boolean {
  if (scopes === undefined || scopes.length === 0) {
    return true;
  }
  return scopes.some((raw) => {
    const s = normalizeScopePrefix(raw);
    return s === "" || canonicalKey === s || canonicalKey.startsWith(`${s}/`);
  });
}

/**
 * Drop prefixes already covered by a shorter one and de-duplicate: keeping
 * both `jscore` and `jscore/Forms4` would make the second one dead weight the
 * user has to maintain.
 */
export function normalizeSyncScopes(scopes: readonly string[]): string[] {
  const cleaned = [...new Set(scopes.map(normalizeScopePrefix).filter((s) => s !== ""))].sort();
  const out: string[] = [];
  for (const s of cleaned) {
    if (!out.some((kept) => s === kept || s.startsWith(`${kept}/`))) {
      out.push(s);
    }
  }
  return out;
}
