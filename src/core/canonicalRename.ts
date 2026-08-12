/**
 * Canonical path editing — the pure heart of moving manifest keys
 * (docs/v3/canonicalPaths.md).
 *
 * A canonical rename is the existing wire shape, batched: for every move the
 * old row becomes a tombstone and an HEIR row appears at the new key carrying
 * `renamedFrom` plus the inherited identity (`linkId`), label and machine
 * placements (`bindings`). No new manifest fields, schemaVersion stays 1 —
 * 1.1.x clients replay each pair with their existing `renamedFrom` code.
 *
 * Batch invariant: every row a batch touches — tombstones and heirs alike —
 * carries ONE Lamport version and one timestamp. Two machines renaming the
 * same folder concurrently therefore converge folder-atomically in row-LWW
 * merge: one batch wins wholesale, never file-by-file ("porvannaya papka").
 * The losing batch's heirs surface as duplicate linkIds and are collapsed by
 * the deterministic `repairDuplicateLinkIds` that rides every 412-merge.
 *
 * Identity materialisation: a legacy row living off the deterministic backfill
 * (`sha256(path + addedAt)`) would silently change identity when its path
 * changes — so a rename writes the id EXPLICITLY into both rows of the pair.
 */
import type { BindingEntry, CloudManifest, ManifestFile } from "./cloudLayout.js";
import { defaultLinkName, deterministicLinkId } from "./linkIdentity.js";

export interface CanonicalMove {
  from: string;
  to: string;
}

export type RenameSkipReason =
  /** No live row at `from` (already moved, tombstoned, or never existed). */
  | "missing"
  /** A live row outside the batch already occupies `to`. */
  | "collision"
  /** `from` and `to` are the same key. */
  | "identity";

export interface RenamedKeysSkip {
  move: CanonicalMove;
  reason: RenameSkipReason;
}

export interface RenamedKeysResult {
  manifest: CloudManifest;
  /** Moves actually materialised as tombstone + heir pairs. */
  applied: CanonicalMove[];
  skipped: RenamedKeysSkip[];
  /** The single Lamport version stamped on every touched row. */
  batchVersion: number;
}

/** Live rows under a canonical dir prefix, expanded to per-file moves. */
export function expandPrefixMove(
  files: readonly ManifestFile[],
  fromPrefix: string,
  toPrefix: string,
): CanonicalMove[] {
  const cut = fromPrefix.length + 1;
  return files
    .filter((f) => !f.removedAt && f.path.startsWith(`${fromPrefix}/`))
    .map((f) => ({ from: f.path, to: `${toPrefix}/${f.path.slice(cut)}` }));
}

/**
 * Folder rules follow a prefix rename in the same PUT: each machine's rule
 * under the old canonical prefix is re-published under the new prefix (same
 * local placement, fresh `boundAt`), and the old key is NEUTRALISED — written
 * as an identity mapping, per the unbinding convention. Deleting it instead
 * would resurrect from any older copy via union-merge; leaving it live would
 * silently apply a forgotten rule to files someone creates under the old
 * prefix later. Pure; returns the input object when nothing matches.
 */
export function migrateFolderBindingsForPrefixMoves(
  folderBindings: CloudManifest["folderBindings"],
  prefixMoves: readonly CanonicalMove[],
  nowIso: string,
): CloudManifest["folderBindings"] {
  if (!folderBindings || prefixMoves.length === 0) {
    return folderBindings;
  }
  const remap = (prefix: string): string | undefined => {
    for (const m of prefixMoves) {
      if (prefix === m.from) return m.to;
      if (prefix.startsWith(`${m.from}/`)) return `${m.to}${prefix.slice(m.from.length)}`;
    }
    return undefined;
  };
  let changed = false;
  const out: Record<string, Record<string, BindingEntry>> = {};
  for (const [machineId, rules] of Object.entries(folderBindings)) {
    const next: Record<string, BindingEntry> = { ...rules };
    for (const [prefix, entry] of Object.entries(rules)) {
      const moved = remap(prefix);
      if (moved === undefined) continue;
      changed = true;
      next[moved] = { path: entry.path, boundAt: nowIso };
      next[prefix] = { path: prefix, boundAt: nowIso };
    }
    out[machineId] = next;
  }
  return changed ? out : folderBindings;
}

/**
 * The manifest with a batch of canonical moves materialised. Applies every
 * move against the INPUT manifest snapshot (the planner pre-composes chained
 * edits), atomically: collision and liveness checks see the original state
 * plus the set of keys the batch itself vacates. A move whose target is
 * another move's source is refused as a collision — swap cycles need an
 * intermediate name, silently interleaving them would corrupt replay.
 */
export function manifestWithRenamedKeys(input: {
  manifest: CloudManifest;
  moves: readonly CanonicalMove[];
  /** Dir-prefix renames of this batch — drive the folder-rule migration. */
  prefixMoves?: readonly CanonicalMove[];
  nowIso: string;
  /** Workspace-wide next Lamport version (`nextManifestVersion`). */
  nextVersion: number;
  touchMachines: (machines: CloudManifest["machines"], now: string) => CloudManifest["machines"];
}): RenamedKeysResult {
  const { manifest, nowIso } = input;
  const rowByPath = new Map<string, ManifestFile>(manifest.files.map((f) => [f.path, f]));
  const liveAt = (path: string): ManifestFile | undefined => {
    const row = rowByPath.get(path);
    return row && !row.removedAt ? row : undefined;
  };

  const sources = new Set<string>();
  for (const m of input.moves) {
    if (m.from !== m.to && liveAt(m.from)) sources.add(m.from);
  }

  const applied: CanonicalMove[] = [];
  const skipped: RenamedKeysSkip[] = [];
  const claimedTargets = new Set<string>();
  for (const move of input.moves) {
    if (move.from === move.to) {
      skipped.push({ move, reason: "identity" });
      continue;
    }
    if (!liveAt(move.from) || claimedTargets.has(move.from)) {
      skipped.push({ move, reason: "missing" });
      continue;
    }
    // Occupied target: a live row that the batch does not itself move away,
    // a target already claimed by this batch, or a swap-cycle source.
    if (
      claimedTargets.has(move.to) ||
      sources.has(move.to) ||
      (liveAt(move.to) !== undefined && !sources.has(move.to))
    ) {
      skipped.push({ move, reason: "collision" });
      continue;
    }
    claimedTargets.add(move.to);
    applied.push(move);
  }

  if (applied.length === 0) {
    return { manifest, applied, skipped, batchVersion: 0 };
  }

  // One version for the whole batch — folder-atomic convergence (see header).
  let batchVersion = input.nextVersion;
  for (const move of applied) {
    const oldRow = rowByPath.get(move.from);
    const rowAtTarget = rowByPath.get(move.to);
    batchVersion = Math.max(
      batchVersion,
      (oldRow?.version ?? 0) + 1,
      (rowAtTarget?.version ?? 0) + 1,
    );
  }

  const tombstoneByPath = new Map<string, ManifestFile>();
  const heirByPath = new Map<string, ManifestFile>();
  for (const move of applied) {
    const oldRow = rowByPath.get(move.from);
    if (!oldRow) continue;
    // Identity must be explicit on both rows of the pair: the deterministic
    // backfill depends on the path and would fork after the move.
    const linkId = oldRow.linkId ?? deterministicLinkId(oldRow.path, oldRow.addedAt);
    tombstoneByPath.set(move.from, {
      ...oldRow,
      linkId,
      removedAt: nowIso,
      version: batchVersion,
    });
    // A default label follows the file name; a custom one is the user's.
    const linkName =
      oldRow.linkName === undefined
        ? undefined
        : oldRow.linkName === defaultLinkName(move.from)
          ? defaultLinkName(move.to)
          : oldRow.linkName;
    // Built from scratch — spreading over a tombstone parked at `to` used to
    // leak its `removedAt` into the heir (a live rename produced a dead row).
    heirByPath.set(move.to, {
      path: move.to,
      addedAt: nowIso,
      version: batchVersion,
      hasSyncignoreMarkers: oldRow.hasSyncignoreMarkers,
      renamedFrom: move.from,
      renamedAt: nowIso,
      linkId,
      ...(linkName !== undefined ? { linkName } : {}),
      ...(oldRow.bindings !== undefined ? { bindings: { ...oldRow.bindings } } : {}),
    });
  }

  const files: ManifestFile[] = [];
  for (const f of manifest.files) {
    const tombstone = tombstoneByPath.get(f.path);
    if (tombstone) {
      files.push(tombstone);
      continue;
    }
    // A tombstone parked at a target key is superseded by the heir (added below).
    if (heirByPath.has(f.path)) continue;
    files.push(f);
  }
  for (const heir of heirByPath.values()) {
    files.push(heir);
  }

  const folderBindings = migrateFolderBindingsForPrefixMoves(
    manifest.folderBindings,
    input.prefixMoves ?? [],
    nowIso,
  );

  return {
    manifest: {
      ...manifest,
      updatedAt: nowIso,
      machines: input.touchMachines(manifest.machines, nowIso),
      files,
      ...(folderBindings !== undefined ? { folderBindings } : {}),
    },
    applied,
    skipped,
    batchVersion,
  };
}

/**
 * The single dir-prefix move that explains EVERY pair, if one exists — lets
 * the receiving side show «папка X → Y (N файлов)» instead of N per-file
 * toasts. Derived by stripping the longest common path suffix of each pair;
 * `null` when the pairs do not share one transformation (mixed edits).
 */
export function inferCommonPrefixMove(
  moves: readonly CanonicalMove[],
): CanonicalMove | null {
  if (moves.length === 0) return null;
  let candidate: CanonicalMove | null | undefined;
  for (const m of moves) {
    const from = m.from.split("/");
    const to = m.to.split("/");
    let shared = 0;
    while (
      shared < from.length - 1 &&
      shared < to.length - 1 &&
      from[from.length - 1 - shared] === to[to.length - 1 - shared]
    ) {
      shared++;
    }
    if (shared === 0) return null;
    const pair: CanonicalMove = {
      from: from.slice(0, from.length - shared).join("/"),
      to: to.slice(0, to.length - shared).join("/"),
    };
    if (candidate === undefined) candidate = pair;
    else if (candidate?.from !== pair.from || candidate.to !== pair.to) return null;
  }
  return candidate ?? null;
}

/**
 * Remap one canonical key through a set of prefix moves (longest match wins) —
 * used for local `syncScopes` after a folder rename. Returns the key unchanged
 * when no prefix matches.
 */
export function remapKeyThroughPrefixMoves(key: string, prefixMoves: readonly CanonicalMove[]): string {
  let best: CanonicalMove | undefined;
  for (const m of prefixMoves) {
    if (key === m.from || key.startsWith(`${m.from}/`)) {
      if (!best || m.from.length > best.from.length) best = m;
    }
  }
  if (!best) return key;
  return key === best.from ? best.to : `${best.to}${key.slice(best.from.length)}`;
}
