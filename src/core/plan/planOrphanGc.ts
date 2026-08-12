/**
 * Orphan GC planner (docs/v3/canonicalPaths.md, follow-up): given a recursive
 * workspace listing, the manifest and `_meta`, decide which cloud objects no
 * live key explains — blobs left by delete-last interruptions and lost rename
 * races, `.history/` of keys nothing points to any more, `_meta` rows union-
 * merge keeps resurrecting. Listing in, verdict out — no I/O.
 *
 * Deletion safety is age-based: an object is an orphan only when its newest
 * dating anchor (listing mtime, tombstone `removedAt`, heir `renamedAt`,
 * `_meta.updatedAt`, the ISO stamp in a history snapshot name) is older than
 * `minAgeMs` — a concurrent push or an in-flight rename on another machine
 * always looks FRESH by every anchor it leaves. Candidates with no anchor at
 * all are reported in `skippedUndatable`, never deleted silently. The caller
 * deletes strictly via `deleteFile` (provider trash, contract D11) after an
 * explicit user confirmation.
 */
import type { ManifestFile } from "../cloudLayout.js";

export interface OrphanGcListedEntry {
  cloudPath: string;
  size?: number;
  modifiedIso?: string;
  isFolder?: boolean;
}

export interface OrphanGcInput {
  /** `workspaceRootPath(workspaceId)` — every listed path starts with it. */
  workspaceCloudRoot: string;
  listed: readonly OrphanGcListedEntry[];
  manifestFiles: readonly ManifestFile[];
  metaFiles: Readonly<Partial<Record<string, { updatedAt: string }>>>;
  nowMs: number;
  /** Objects with every anchor older than this are collectable. */
  minAgeMs: number;
}

export interface OrphanObject {
  cloudPath: string;
  /** Canonical key the object belonged to (blob key or history dir key). */
  key: string;
  size?: number;
}

export interface OrphanGcPlan {
  orphanBlobs: OrphanObject[];
  orphanHistoryFiles: OrphanObject[];
  /** `_meta` rows to drop in one meta write (no blob behind them). */
  orphanMetaKeys: string[];
  /** Candidates without any dating anchor — listed, never touched. */
  skippedUndatable: string[];
  totalBytes: number;
}

const SKIP_NAMES = new Set([".vscodesync-workspace.json", "_meta.json"]);
/** ISO stamp at the start of a history snapshot name (`:`/`.` → `-`). */
const HISTORY_STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/;

function parseIsoMs(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === "") return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

function historyStampMs(snapshotName: string): number | undefined {
  const m = HISTORY_STAMP_RE.exec(snapshotName);
  if (!m) return undefined;
  // `2026-08-12T10-30-05` → `2026-08-12T10:30:05Z`
  const [d, time] = m[1].split("T");
  return parseIsoMs(`${d}T${time.replace(/-/g, ":")}Z`);
}

export function planOrphanGc(input: OrphanGcInput): OrphanGcPlan {
  const rootPrefix = `${input.workspaceCloudRoot}/`;
  const cutoff = input.nowMs - input.minAgeMs;

  const activeKeys = new Set<string>();
  const chainKeys = new Set<string>();
  const tombstoneMsByKey = new Map<string, number>();
  const renamedAtMsByFromKey = new Map<string, number>();
  for (const f of input.manifestFiles) {
    if (f.removedAt === undefined || f.removedAt === "") {
      activeKeys.add(f.path);
    } else {
      const t = parseIsoMs(f.removedAt);
      if (t !== undefined) tombstoneMsByKey.set(f.path, t);
      else tombstoneMsByKey.set(f.path, input.nowMs); // unparsable — treat as fresh
    }
    // Any row's breadcrumb keeps its source key reachable for the history
    // chain reader — those directories are NOT garbage while the crumb lives.
    if (f.renamedFrom !== undefined && f.renamedFrom !== "") {
      chainKeys.add(f.renamedFrom);
      const t = parseIsoMs(f.renamedAt);
      renamedAtMsByFromKey.set(f.renamedFrom, t ?? input.nowMs);
    }
  }

  const metaMsByKey = new Map<string, number>();
  for (const [key, row] of Object.entries(input.metaFiles)) {
    if (row !== undefined) {
      metaMsByKey.set(key, parseIsoMs(row.updatedAt) ?? input.nowMs);
    }
  }

  const orphanBlobs: OrphanObject[] = [];
  const orphanHistoryFiles: OrphanObject[] = [];
  const skippedUndatable: string[] = [];

  const keyIsProtected = (key: string): boolean => {
    if (activeKeys.has(key) || chainKeys.has(key)) return true;
    const tombMs = tombstoneMsByKey.get(key);
    if (tombMs !== undefined && tombMs >= cutoff) return true;
    const metaMs = metaMsByKey.get(key);
    if (metaMs !== undefined && metaMs >= cutoff) return true;
    return false;
  };

  /** Newest anchor that can date the object under `key`; undefined = undatable. */
  const newestAnchorMs = (key: string, entry: OrphanGcListedEntry, extra?: number): number | undefined => {
    const anchors = [
      parseIsoMs(entry.modifiedIso),
      tombstoneMsByKey.get(key),
      renamedAtMsByFromKey.get(key),
      metaMsByKey.get(key),
      extra,
    ].filter((v): v is number => v !== undefined);
    return anchors.length > 0 ? Math.max(...anchors) : undefined;
  };

  for (const entry of input.listed) {
    if (entry.isFolder === true) continue;
    if (!entry.cloudPath.startsWith(rootPrefix)) continue;
    const rel = entry.cloudPath.slice(rootPrefix.length);
    if (SKIP_NAMES.has(rel)) continue;
    if (rel.startsWith(".snapshots/")) continue; // own retention (snapshotRetentionPlan)

    if (rel.startsWith(".history/")) {
      const inner = rel.slice(".history/".length);
      const cut = inner.lastIndexOf("/");
      if (cut <= 0) continue; // malformed — leave alone
      const key = inner.slice(0, cut);
      const name = inner.slice(cut + 1);
      if (keyIsProtected(key)) continue;
      const anchor = newestAnchorMs(key, entry, historyStampMs(name));
      if (anchor === undefined) {
        skippedUndatable.push(entry.cloudPath);
      } else if (anchor < cutoff) {
        orphanHistoryFiles.push({ cloudPath: entry.cloudPath, key, size: entry.size });
      }
      continue;
    }

    const key = rel.endsWith(".gz") ? rel.slice(0, -3) : rel;
    if (keyIsProtected(key)) continue;
    const anchor = newestAnchorMs(key, entry);
    if (anchor === undefined) {
      skippedUndatable.push(entry.cloudPath);
    } else if (anchor < cutoff) {
      orphanBlobs.push({ cloudPath: entry.cloudPath, key, size: entry.size });
    }
  }

  // `_meta` rows for keys with no live row, no fresh tombstone and no blob we
  // are keeping: dropping them is a single meta write. Union-merge may
  // resurrect a row from an older copy — the next GC run re-drops it, the
  // filter is deterministic.
  const orphanMetaKeys: string[] = [];
  for (const [key, ms] of metaMsByKey) {
    if (keyIsProtected(key)) continue;
    if (ms < cutoff) orphanMetaKeys.push(key);
  }
  orphanMetaKeys.sort();

  const totalBytes =
    orphanBlobs.reduce((s, o) => s + (o.size ?? 0), 0) +
    orphanHistoryFiles.reduce((s, o) => s + (o.size ?? 0), 0);

  return { orphanBlobs, orphanHistoryFiles, orphanMetaKeys, skippedUndatable, totalBytes };
}
