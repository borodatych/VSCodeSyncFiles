/**
 * Single owner of `.vscode/vscodesync.json` per workspace root.
 *
 * Every mutation used to be an open read-modify-write against the file:
 * `loadCfg()` read from disk, the caller mutated the object, `saveCfg()` wrote
 * it back. With `sync.workspaceConcurrency` defaulting to 2, two workspace
 * branches interleave those three steps and the second write silently discards
 * whatever the first one recorded — statuses, etags, `lastSync`, tracked files.
 * The temp-file name used by the atomic write was not unique within a
 * millisecond either, so the two writers could even collide on the same temp
 * path.
 *
 * The store fixes both halves:
 *   - reads are served from one in-memory copy, so nobody works off a snapshot
 *     that a concurrent branch has already superseded;
 *   - writes and `mutate()` bodies run on a per-root serialised queue, so a
 *     read-modify-write cannot interleave with another one.
 *
 * Keyed by normalised root at module level on purpose: several `SyncEngine`
 * instances can exist for the same folder (commands, triggers, scheduled
 * helpers), and they must share the owner rather than each holding their own.
 */
import type { WorkspaceConfig } from "./types.js";
import {
  readWorkspaceConfigFromDisk,
  sameStamp,
  statWorkspaceConfig,
  writeWorkspaceConfigToDisk,
  type WorkspaceConfigStamp,
} from "./workspaceConfigFile.js";

export interface WorkspaceConfigStore {
  /** Current config. Served from memory once loaded. */
  load(): Promise<WorkspaceConfig>;
  /** Replace the config. Serialised against other writes for the same root. */
  save(config: WorkspaceConfig): Promise<void>;
  /**
   * Serialised read-modify-write. `fn` receives the live config and may mutate
   * it; the result is written once `fn` resolves. No other `mutate` or `save`
   * for this root runs in between.
   */
  mutate<T>(fn: (config: WorkspaceConfig) => Promise<T> | T): Promise<T>;
  /** Drop the in-memory copy — next `load` re-reads from disk. */
  invalidate(): void;
}

function normaliseRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

interface StoreState {
  cached: WorkspaceConfig | undefined;
  /**
   * File identity at the moment `cached` was read or written. A second VS Code
   * window, a manual edit or a git checkout can rewrite the file behind our
   * back, so the cache is only trusted while the stamp still matches — one
   * `stat` per load, against a full read plus JSON parse.
   */
  stamp: WorkspaceConfigStamp | undefined;
  tail: Promise<unknown>;
}

const stores = new Map<string, StoreState>();

function stateFor(root: string): StoreState {
  const key = normaliseRoot(root);
  let st = stores.get(key);
  if (!st) {
    st = { cached: undefined, stamp: undefined, tail: Promise.resolve() };
    stores.set(key, st);
  }
  return st;
}

export function getWorkspaceConfigStore(workspaceRoot: string): WorkspaceConfigStore {
  const st = stateFor(workspaceRoot);

  /** Cached config if the file on disk still matches what we last saw. */
  const readFresh = async (): Promise<WorkspaceConfig> => {
    const onDisk = await statWorkspaceConfig(workspaceRoot);
    if (st.cached !== undefined && sameStamp(onDisk, st.stamp)) {
      return st.cached;
    }
    const loaded = await readWorkspaceConfigFromDisk(workspaceRoot);
    st.cached = loaded;
    st.stamp = onDisk;
    return loaded;
  };

  const writeAndStamp = async (config: WorkspaceConfig): Promise<void> => {
    await writeWorkspaceConfigToDisk(config, workspaceRoot);
    st.cached = config;
    st.stamp = await statWorkspaceConfig(workspaceRoot);
  };

  /** Queue `fn` behind everything already queued for this root. */
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = st.tail.then(fn, fn);
    // The tail must never reject, otherwise one failed mutation would poison
    // every later one queued behind it.
    st.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    load(): Promise<WorkspaceConfig> {
      return enqueue(() => readFresh());
    },

    save(config: WorkspaceConfig): Promise<void> {
      return enqueue(() => writeAndStamp(config));
    },

    mutate<T>(fn: (config: WorkspaceConfig) => Promise<T> | T): Promise<T> {
      return enqueue(async () => {
        const config = await readFresh();
        const result = await fn(config);
        await writeAndStamp(config);
        return result;
      });
    },

    invalidate(): void {
      st.cached = undefined;
      st.stamp = undefined;
    },
  };
}

/** Test seam — drops every cached config and queue. */
export function resetWorkspaceConfigStores(): void {
  stores.clear();
}
