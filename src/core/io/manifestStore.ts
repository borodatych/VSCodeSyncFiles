/**
 * `manifest.json` — download, parse, upload, and the etag-matched cache.
 *
 * Extracted from `SyncEngine` (этап 5.2). Four things belong together here and
 * were spread across the engine:
 *   - the cache is only valid *for the etag it came from* (serving an older
 *     body for a newer etag once made "apply what the detector reported" a
 *     silent no-op);
 *   - a body that fails to parse is **not** a missing manifest — callers read
 *     `null` as "another machine deleted this workspace" and detach, so a
 *     truncated read must throw instead;
 *   - tombstones age out on write, not on read;
 *   - a 412 means someone else wrote in between: merge and retry, never
 *     overwrite.
 *
 * Policy stays with the engine via `beforeWrite` / `onMassChange`.
 */
import type { ICloudProvider } from "../../providers/cloudProviderTypes.js";
import { ProviderError } from "../../providers/cloudProviderTypes.js";
import { manifestCloudPath, type CloudManifest } from "../cloudLayout.js";
import { mergeCloudManifests } from "../manifestMerger.js";
import { validateManifestShape } from "../manifestValidate.js";
import { detectMassChange, type MassChangeReport } from "../massChangeGuard.js";
import { warnLog } from "../../utils/log.js";

/** A manifest that exists but cannot be read. Distinct from "not there". */
export class ManifestCorruptError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly reason: string,
  ) {
    super(
      `VSCodeSync: облачный манифест воркспейса ${workspaceId} повреждён (${reason}). ` +
        "Локальный трекинг сохранён. Используйте «Repair cloud manifest», если повреждение постоянное.",
    );
    this.name = "ManifestCorruptError";
  }
}

export interface ManifestStoreDeps {
  provider: ICloudProvider;
  /** Tombstones older than this are dropped on write. `<= 0` disables. */
  tombstonePurgeDays: () => number;
  /** Called when a body fails to parse, before the throw. */
  onCorrupt?: (workspaceId: string, reason: string) => void;
  /** Persist the new etag and whatever the manifest carries for the entry. */
  onEtag: (workspaceId: string, etag: string, manifest: CloudManifest) => Promise<void>;
  /** The etag currently recorded for this workspace, used on a 412 retry. */
  currentEtag: (workspaceId: string) => Promise<string | undefined>;
  /** Engine-side policy gate before any upload. May throw. */
  beforeWrite: (workspaceId: string) => Promise<void>;
  /** Confirmation hook for a write that tombstones a large batch. */
  onMassChange?: (workspaceId: string, report: MassChangeReport) => Promise<boolean>;
}

export interface ManifestStore {
  /** `null` only for NOT_FOUND. A corrupt body throws {@link ManifestCorruptError}. */
  download(workspaceId: string, ifNoneMatch: string | undefined): Promise<CloudManifest | null>;
  put(
    workspaceId: string,
    manifest: CloudManifest,
    ifMatch: string | undefined,
    retries?: number,
  ): Promise<string | undefined>;
  parse(workspaceId: string, body: Buffer): CloudManifest;
  peek(workspaceId: string): CloudManifest | undefined;
  cache(workspaceId: string, manifest: CloudManifest, etag: string | undefined): void;
  forget(workspaceId: string): void;
}

/**
 * Drop tombstones and rename breadcrumbs past their retention. Pure.
 */
export function purgeTombstones(manifest: CloudManifest, purgeDays: number): CloudManifest {
  if (purgeDays <= 0) {
    return manifest;
  }
  const cutoff = Date.now() - purgeDays * 24 * 60 * 60 * 1000;
  const files = manifest.files
    .filter((f) => {
      if (!f.removedAt) {
        return true;
      }
      const t = Date.parse(f.removedAt);
      return Number.isNaN(t) || t >= cutoff;
    })
    .map((f) => {
      if (!f.renamedFrom || !f.renamedAt) {
        return f;
      }
      const t = Date.parse(f.renamedAt);
      if (!Number.isNaN(t) && t < cutoff) {
        const { renamedFrom: _dropFrom, renamedAt: _dropAt, ...rest } = f;
        return rest;
      }
      return f;
    });
  return files.length === manifest.files.length && files.every((f, i) => f === manifest.files[i])
    ? manifest
    : { ...manifest, files };
}

export function createManifestStore(deps: ManifestStoreDeps): ManifestStore {
  const byWs = new Map<string, CloudManifest>();
  /** Which etag the cached body belongs to. */
  const etagByWs = new Map<string, string>();

  const cache = (workspaceId: string, manifest: CloudManifest, etag: string | undefined): void => {
    byWs.set(workspaceId, manifest);
    if (etag !== undefined && etag !== "") {
      etagByWs.set(workspaceId, etag);
    } else {
      etagByWs.delete(workspaceId);
    }
  };

  const parse = (workspaceId: string, body: Buffer): CloudManifest => {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as CloudManifest;
      if (!parsed.workspaceId || !Array.isArray(parsed.files)) {
        throw new Error("manifest schema mismatch");
      }
      return parsed;
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      warnLog("manifestStore", `manifest corrupt for ${workspaceId}: ${reason}`);
      deps.onCorrupt?.(workspaceId, reason);
      throw new ManifestCorruptError(workspaceId, reason);
    }
  };

  const store: ManifestStore = {
    parse,
    peek: (workspaceId) => byWs.get(workspaceId),
    cache,
    forget(workspaceId): void {
      byWs.delete(workspaceId);
      etagByWs.delete(workspaceId);
    },

    async download(workspaceId, ifNoneMatch): Promise<CloudManifest | null> {
      let dl;
      try {
        dl = await deps.provider.downloadFile(manifestCloudPath(workspaceId), { ifNoneMatch });
      } catch (e) {
        if (e instanceof ProviderError && e.code === "NOT_FOUND") {
          return null;
        }
        throw e;
      }
      if (dl.notModified) {
        // The cache answers a 304 only when its body is the one the etag names:
        // `ifNoneMatch` comes from the shared config store, which another engine
        // instance may have advanced past this instance's copy.
        const cached = byWs.get(workspaceId);
        if (cached && etagByWs.get(workspaceId) === ifNoneMatch) {
          return cached;
        }
        const full = await deps.provider.downloadFile(manifestCloudPath(workspaceId));
        const m = parse(workspaceId, full.body);
        cache(workspaceId, m, full.etag);
        if (full.etag) {
          await deps.onEtag(workspaceId, full.etag, m);
        }
        return m;
      }
      const m = parse(workspaceId, dl.body);
      cache(workspaceId, m, dl.etag);
      if (dl.etag) {
        await deps.onEtag(workspaceId, dl.etag, m);
      }
      return m;
    },

    async put(workspaceId, manifest, ifMatch, retries = 3): Promise<string | undefined> {
      await deps.beforeWrite(workspaceId);
      try {
        const clean = purgeTombstones(manifest, deps.tombstonePurgeDays());
        // Never push a manifest we would reject on download.
        const validation = validateManifestShape(clean);
        if (!validation.ok) {
          throw new Error(`putManifest aborted: ${validation.reason}`);
        }
        // Only ask on the first attempt: a 412 retry carries our own prior
        // intent, already confirmed.
        if (deps.onMassChange && retries === 3) {
          const report = detectMassChange(byWs.get(workspaceId), clean);
          if (report.triggered) {
            const proceed = await deps.onMassChange(workspaceId, report);
            if (!proceed) throw new Error("putManifest aborted: mass-change guard");
          }
        }
        const body = Buffer.from(`${JSON.stringify(clean, null, 2)}\n`, "utf8");
        const res = await deps.provider.uploadFile(manifestCloudPath(workspaceId), body, { ifMatch });
        if (res.etag) {
          await deps.onEtag(workspaceId, res.etag, clean);
        }
        cache(workspaceId, clean, res.etag);
        return res.etag;
      } catch (e) {
        if (e instanceof ProviderError && e.code === "PRECONDITION_FAILED" && retries > 0) {
          const freshEtag = await deps.currentEtag(workspaceId);
          const remote = await store.download(workspaceId, freshEtag);
          if (!remote) {
            throw e;
          }
          return store.put(workspaceId, mergeCloudManifests(manifest, remote), freshEtag, retries - 1);
        }
        throw e;
      }
    },
  };

  return store;
}
