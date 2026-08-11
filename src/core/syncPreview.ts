/**
 * Dry-run sync preview (extracted verbatim from `syncEngine.previewSyncPlan`
 * — engine line-ceiling offset for Link Bindings stage 3). Touches the cloud
 * through the injected provider, so it lives in core/ next to
 * `cloudWorkspaceLister`, not in plan/. Hashing and blob decoding come from
 * the engine through narrow callbacks — cloud state is keyed canonically
 * (`manifestKeyOf`), disk access stays on the local path.
 */
import { manifestCloudPath, metaCloudPath, SUPPORTED_MANIFEST_SCHEMA } from "./cloudLayout.js";
import type { CloudManifest, MetaJson } from "./cloudLayout.js";
import { planFileAction } from "./plan/planFileAction.js";
import { manifestKeyOf } from "./trackedPathResolver.js";
import type { WorkspaceConfig } from "./types.js";
import { ProviderError, type ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { PreviewSyncFileAction, SyncPreviewFileRow, SyncPreviewWorkspace } from "./syncEngine.js";

export interface SyncPreviewDeps {
  cfg: WorkspaceConfig;
  workspaceIds: readonly string[];
  provider: ICloudProvider;
  decodeCloudBlob: (body: Buffer, wireGzip: boolean) => Buffer;
  /** Canonical hash of local bytes at `localPath`, keyed by the manifest key; "" when absent. */
  hashLocalTracked: (localPath: string, manifestKey: string) => Promise<string>;
  /** Canonical hash of decoded cloud bytes, keyed by the manifest key. */
  hashCloudBuffer: (buf: Buffer, manifestKey: string) => string;
}

export async function buildSyncPreview(deps: SyncPreviewDeps): Promise<SyncPreviewWorkspace[]> {
  const { cfg, provider } = deps;
  const results: SyncPreviewWorkspace[] = [];

  for (const wsId of deps.workspaceIds) {
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === wsId);
    if (!entry) {
      continue;
    }

    let manifest: CloudManifest;
    try {
      const manifestDl = await provider.downloadFile(manifestCloudPath(wsId));
      const bodyStr = manifestDl.body.toString("utf8");
      const parsed = JSON.parse(bodyStr) as {
        schemaVersion?: unknown;
        workspaceId?: unknown;
        files?: CloudManifest["files"];
      };
      if (parsed.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA || parsed.workspaceId !== wsId) {
        throw new Error(`некорректный манифест workspace ${wsId}`);
      }
      manifest = parsed as CloudManifest;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        // Cloud manifest missing — treat all locally tracked files as pending push
        const localRows: SyncPreviewFileRow[] = cfg.files
          .filter((f) => f.workspaceId === wsId)
          .map((f) => ({ localPath: f.localPath, action: "push" }));
        localRows.sort((a, b) => a.localPath.localeCompare(b.localPath, undefined, { sensitivity: "base" }));
        results.push({ workspaceId: wsId, workspaceNote: entry.workspaceNote, files: localRows });
        continue;
      }
      throw e;
    }

    let meta: MetaJson;
    try {
      const metaDl = await provider.downloadFile(metaCloudPath(wsId));
      meta = JSON.parse(metaDl.body.toString("utf8")) as MetaJson;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        meta = { files: {} };
      } else {
        throw e;
      }
    }

    const activeManifestPaths = new Set(
      manifest.files.filter((f) => !f.removedAt).map((f) => f.path),
    );
    const trackedFiles = cfg.files.filter(
      (f) => f.workspaceId === wsId && activeManifestPaths.has(manifestKeyOf(f)),
    );

    const rows: SyncPreviewFileRow[] = [];
    for (const file of trackedFiles) {
      if (file.syncStatus === "conflict") {
        rows.push({ localPath: file.localPath, action: "conflict_pending" });
        continue;
      }
      const key = manifestKeyOf(file);
      const metaRow = meta.files[key];
      const base = metaRow === undefined ? undefined : metaRow.hash;
      const localCurrent = await deps.hashLocalTracked(file.localPath, key);
      let cloudCurrent = "";
      try {
        // Conditional GET (этап 5.2): the preview used to download the full
        // body of every tracked file on every run — the one pass that reads
        // the whole workspace, doing it the most expensive way possible.
        // A 304 means the blob still hashes to `_meta.hash`, which is exactly
        // what we were about to compute.
        const dl = await provider.downloadFile(file.cloudPath, {
          ifNoneMatch: metaRow?.etag !== undefined && metaRow.etag !== "" ? metaRow.etag : undefined,
        });
        if (dl.notModified) {
          cloudCurrent = base ?? "";
        } else {
          const plain = deps.decodeCloudBlob(dl.body, metaRow?.wireGzip === true);
          cloudCurrent = deps.hashCloudBuffer(plain, key);
        }
      } catch (e) {
        if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
          throw e;
        }
        cloudCurrent = "";
      }

      const action: PreviewSyncFileAction = planFileAction({
        baseHash: base,
        cachedLocalHash: file.localHash,
        localHash: localCurrent,
        cloudHash: cloudCurrent,
      }).action;
      rows.push({ localPath: file.localPath, action });
    }

    rows.sort((a, b) => a.localPath.localeCompare(b.localPath, undefined, { sensitivity: "base" }));
    results.push({
      workspaceId: wsId,
      workspaceNote: entry.workspaceNote,
      files: rows,
    });
  }

  return results;
}
