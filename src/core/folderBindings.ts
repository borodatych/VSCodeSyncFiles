/**
 * Link Bindings — folder placement rules (docs/v2/linkBindings.md).
 *
 * A machine may keep a whole canonical folder under a different local name
 * with the same structure inside (work: `promed/**`, home: `php/**`). The
 * rule lives in `CloudManifest.folderBindings[machineId]` as
 * `canonical dir prefix → { path: local dir prefix, boundAt }` and is applied
 * at the three points where a tracked row is born: bind-folder (existing
 * files), adoption (future cloud files) and add (future local files).
 * `TrackedFile.manifestPath` stays the per-row workhorse — sync flows never
 * consult these rules directly.
 *
 * Pure string logic; no I/O, no engine state.
 */
import type { BindingEntry } from "./cloudLayout.js";

export type FolderBindingRules = Record<string, BindingEntry> | undefined;

/** Strip leading/trailing slashes; empty string means "no prefix". */
export function normalizeDirPrefix(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

function isUnder(rel: string, dirPrefix: string): boolean {
  return dirPrefix !== "" && rel.startsWith(`${dirPrefix}/`);
}

/**
 * Canonical manifest key for a file at `localRel` on this machine, or
 * `undefined` when no rule matches. Longest local prefix wins — nested rules
 * resolve to the most specific placement.
 */
export function canonicalKeyForLocalPath(rules: FolderBindingRules, localRel: string): string | undefined {
  let best: { local: string; canonical: string } | undefined;
  for (const [canonical, entry] of Object.entries(rules ?? {})) {
    const local = normalizeDirPrefix(entry.path);
    if (isUnder(localRel, local) && (best === undefined || local.length > best.local.length)) {
      best = { local, canonical: normalizeDirPrefix(canonical) };
    }
  }
  return best === undefined ? undefined : `${best.canonical}/${localRel.slice(best.local.length + 1)}`;
}

/**
 * Local placement for a canonical manifest key on this machine, or
 * `undefined` when no rule matches. Longest canonical prefix wins.
 */
export function localPathForCanonicalKey(rules: FolderBindingRules, canonicalRel: string): string | undefined {
  let best: { canonical: string; local: string } | undefined;
  for (const [canonical, entry] of Object.entries(rules ?? {})) {
    const canon = normalizeDirPrefix(canonical);
    if (isUnder(canonicalRel, canon) && (best === undefined || canon.length > best.canonical.length)) {
      best = { canonical: canon, local: normalizeDirPrefix(entry.path) };
    }
  }
  return best === undefined ? undefined : `${best.local}/${canonicalRel.slice(best.canonical.length + 1)}`;
}
