/**
 * v0.7 — pure in-memory cache of Google Drive folder ids by absolute path.
 *
 * Why this exists. The Drive API has no path lookup: resolving
 * `VSCodeSyncFiles/<wid>/src/core/foo.ts` requires one `files.list?q=name=…`
 * GET per path segment. For a deeply-nested file that's 5–6 GETs *before*
 * any actual upload. Every push paid this in full because the provider had
 * no memoisation. Tests on a real Drive account show 60–80% wall-clock time
 * spent in folder lookups on small files.
 *
 * Contract:
 *   - `path` is the slash-joined absolute path under the cloud root (without
 *     leading slash). Examples: `"VSCodeSyncFiles"`, `"VSCodeSyncFiles/wid/src"`.
 *   - Entries expire after `ttlMs`. `0` disables the cache entirely (every
 *     call is a miss).
 *   - `invalidate(path)` drops the exact path; `invalidatePrefix(path)`
 *     drops the path and everything beneath it (use on 404 / rename).
 *
 * No `vscode` import. Unit-testable. Engine wires it into the gdrive
 * provider via dependency injection.
 */

interface CacheEntry {
  id: string;
  expiresAtMs: number;
}

export interface GdriveFolderIdCacheOptions {
  /** Time-to-live for cached entries (ms). 0 disables the cache. */
  ttlMs: number;
  /** Override `Date.now()` — for unit tests. */
  nowMs?: () => number;
}

export interface IGdriveFolderIdCache {
  get(path: string): string | undefined;
  set(path: string, id: string): void;
  invalidate(path: string): void;
  invalidatePrefix(path: string): void;
  clear(): void;
  /** Number of live (non-expired) entries — used by diagnostics tests. */
  size(): number;
}

export function createGdriveFolderIdCache(
  opts: GdriveFolderIdCacheOptions,
): IGdriveFolderIdCache {
  const ttlMs = Math.max(0, opts.ttlMs | 0);
  const now = opts.nowMs ?? ((): number => Date.now());
  const store = new Map<string, CacheEntry>();

  const isLive = (e: CacheEntry, t: number): boolean => e.expiresAtMs > t;

  return {
    get(path: string): string | undefined {
      if (ttlMs === 0) return undefined;
      const e = store.get(path);
      if (!e) return undefined;
      if (!isLive(e, now())) {
        store.delete(path);
        return undefined;
      }
      return e.id;
    },
    set(path: string, id: string): void {
      if (ttlMs === 0) return;
      store.set(path, { id, expiresAtMs: now() + ttlMs });
    },
    invalidate(path: string): void {
      store.delete(path);
    },
    invalidatePrefix(path: string): void {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },
    clear(): void {
      store.clear();
    },
    size(): number {
      const t = now();
      let n = 0;
      for (const e of store.values()) {
        if (isLive(e, t)) n += 1;
      }
      return n;
    },
  };
}
