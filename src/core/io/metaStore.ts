/**
 * `_meta.json` — read, write, and the in-memory copy everything else reads.
 *
 * Extracted from `SyncEngine` (этап 5.2). The engine kept the cache, the
 * conditional-GET handling, the etag bookkeeping and the 412-merge retry loop
 * inline, which meant every caller had to know that `pullMeta` might refresh
 * the entry's etag as a side effect. Here that is the store's business.
 *
 * Policy stays out: `beforeWrite` is where the engine puts its "may I mutate?"
 * checks, so this module never decides whether a write is allowed — only how it
 * is performed.
 */
import type { ICloudProvider } from "../../providers/cloudProviderTypes.js";
import { ProviderError } from "../../providers/cloudProviderTypes.js";
import { metaCloudPath, type MetaJson } from "../cloudLayout.js";
import { mergeMetaEntries } from "../metaMerge.js";

/**
 * Why a `_meta` write happens. A pull that finished still has to record what it
 * downloaded, and that is the one write a read-only secondary window may make;
 * everything else it must not. Passing the reason as an argument replaced a
 * process-wide depth counter that leaked across concurrent operations (F7).
 */
export type MetaWriteReason = "push" | "pull-completion";

export interface MetaStoreDeps {
  provider: ICloudProvider;
  /** How many times a 412 may be merged and retried. */
  metaWriteRetries: () => number;
  /** Persist the new `metaEtag` on the workspace entry. */
  onEtag: (workspaceId: string, etag: string) => Promise<void>;
  /** Engine-side policy gate, run before every write. May throw. */
  beforeWrite: (workspaceId: string, reason: MetaWriteReason) => Promise<void>;
}

export interface MetaStore {
  /** Conditional GET; falls back to the cached copy on 304 and `{files:{}}` on 404. */
  pull(workspaceId: string, ifNoneMatch: string | undefined): Promise<MetaJson>;
  /** Upload with `ifMatch`, merging and retrying on 412. Returns the new etag. */
  push(
    workspaceId: string,
    meta: MetaJson,
    ifMatch: string | undefined,
    reason: MetaWriteReason,
  ): Promise<string>;
  /** In-memory copy, without touching the network. */
  peek(workspaceId: string): MetaJson | undefined;
  /** Replace the in-memory copy (used after a local rebuild). */
  put(workspaceId: string, meta: MetaJson): void;
  /** Forget the workspace (detach / delete / merge). */
  forget(workspaceId: string): void;
}

export function createMetaStore(deps: MetaStoreDeps): MetaStore {
  const cache = new Map<string, MetaJson>();

  const parse = (body: Buffer): MetaJson => JSON.parse(body.toString("utf8")) as MetaJson;

  return {
    async pull(workspaceId, ifNoneMatch): Promise<MetaJson> {
      try {
        const dl = await deps.provider.downloadFile(metaCloudPath(workspaceId), { ifNoneMatch });
        if (dl.notModified) {
          const cached = cache.get(workspaceId);
          if (cached) {
            return cached;
          }
          // 304 without a cached copy: the etag came from a previous session.
          const full = await deps.provider.downloadFile(metaCloudPath(workspaceId));
          if (full.etag) {
            await deps.onEtag(workspaceId, full.etag);
          }
          const parsed = parse(full.body);
          cache.set(workspaceId, parsed);
          return parsed;
        }
        if (dl.etag) {
          await deps.onEtag(workspaceId, dl.etag);
        }
        const parsed = parse(dl.body);
        cache.set(workspaceId, parsed);
        return parsed;
      } catch (e) {
        if (e instanceof ProviderError && e.code === "NOT_FOUND") {
          const empty: MetaJson = { files: {} };
          cache.set(workspaceId, empty);
          return empty;
        }
        throw e;
      }
    },

    async push(workspaceId, meta, ifMatch, reason): Promise<string> {
      await deps.beforeWrite(workspaceId, reason);
      let etag = ifMatch;
      let current = meta;
      const retries = deps.metaWriteRetries();
      for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
          const body = Buffer.from(`${JSON.stringify(current, null, 2)}\n`, "utf8");
          const res = await deps.provider.uploadFile(metaCloudPath(workspaceId), body, {
            ifMatch: etag,
          });
          if (res.etag) {
            await deps.onEtag(workspaceId, res.etag);
          }
          cache.set(workspaceId, current);
          return res.etag ?? "";
        } catch (e) {
          if (!(e instanceof ProviderError) || e.code !== "PRECONDITION_FAILED") {
            throw e;
          }
          // Someone else wrote in between: merge their rows into ours rather
          // than overwriting, then retry against their etag.
          const remoteBuf = await deps.provider.downloadFile(metaCloudPath(workspaceId));
          current = mergeMetaEntries(current, parse(remoteBuf.body));
          etag = remoteBuf.etag;
        }
      }
      throw new Error("pushMetaJson: retries exhausted");
    },

    peek(workspaceId): MetaJson | undefined {
      return cache.get(workspaceId);
    },

    put(workspaceId, meta): void {
      cache.set(workspaceId, meta);
    },

    forget(workspaceId): void {
      cache.delete(workspaceId);
    },
  };
}
