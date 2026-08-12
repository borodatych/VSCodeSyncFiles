/**
 * Tracked-blob and history readers, extracted from `syncEngine.ts` for its
 * line ceiling. Everything keys by the canonical manifest key (Link Bindings);
 * history reads span the rename chain (linkKeyChain.ts) — snapshots live under
 * the key that was canonical when they were taken.
 */
import type { FileMetadata, ICloudProvider } from "../../providers/cloudProviderTypes.js";
import type { CloudManifest, MetaJson } from "../cloudLayout.js";
import { historyPathOwnedByChain, listHistoryAcrossKeys } from "./historyChainReader.js";
import { priorCanonicalKeys } from "../linkKeyChain.js";
import { manifestKeyOf } from "../trackedPathResolver.js";
import type { TrackedFile, WorkspaceConfig } from "../types.js";
import { blobCloudPath } from "../wireCompression.js";

export interface TrackedBlobReaderDeps {
  provider: ICloudProvider;
  loadCfg: () => Promise<WorkspaceConfig>;
  pullMeta: (workspaceId: string, metaEtag: string | undefined) => Promise<MetaJson>;
  downloadManifest: (workspaceId: string, ifNoneMatch: string | undefined) => Promise<CloudManifest | null>;
  decode: (body: Buffer, wireGzip: boolean) => Buffer;
  abortSignal?: AbortSignal;
}

/**
 * Shared prologue of the readers: tracked row by local path, its workspace
 * entry, `_meta` row and wire codec.
 */
async function trackedReadContext(
  deps: TrackedBlobReaderDeps,
  posixRel: string,
): Promise<{ hit: TrackedFile; key: string; wireGzip: boolean }> {
  const cfg = await deps.loadCfg();
  const hit = cfg.files.find((f) => f.localPath === posixRel);
  if (!hit) {
    throw new Error("not tracked");
  }
  const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === hit.workspaceId);
  if (!ent) {
    throw new Error("no entry");
  }
  const meta = await deps.pullMeta(hit.workspaceId, ent.metaEtag);
  const key = manifestKeyOf(hit);
  return { hit, key, wireGzip: meta.files[key]?.wireGzip === true };
}

/** Current canonical key + prior chain keys; degrades to the current key alone offline. */
async function historyKeyChain(deps: TrackedBlobReaderDeps, hit: TrackedFile): Promise<string[]> {
  const key = manifestKeyOf(hit);
  const entry = (await deps.loadCfg()).activeWorkspaces.find((w) => w.workspaceId === hit.workspaceId);
  const m = entry
    ? await deps.downloadManifest(hit.workspaceId, entry.manifestEtag).catch(() => null)
    : null;
  return m ? [key, ...priorCanonicalKeys(m.files, key)] : [key];
}

/** Download with one retry on an empty 304 body (provider cache quirk). */
async function downloadCloudBytes(deps: TrackedBlobReaderDeps, cloudPath: string): Promise<Buffer> {
  let dl = await deps.provider.downloadFile(cloudPath, { signal: deps.abortSignal });
  if (dl.notModified && dl.body.length === 0) {
    dl = await deps.provider.downloadFile(cloudPath, { signal: deps.abortSignal });
  }
  return dl.body;
}

/**
 * Снимки в `.history/` для файла (новые первыми) — включая снимки под прежними
 * каноническими именами: история следует за файлом сквозь переименования.
 */
export async function listTrackedFileHistory(
  deps: TrackedBlobReaderDeps,
  posixRel: string,
): Promise<FileMetadata[]> {
  const cfg = await deps.loadCfg();
  const hit = cfg.files.find((f) => f.localPath === posixRel);
  if (!hit) {
    throw new Error("not tracked");
  }
  return listHistoryAcrossKeys(deps.provider, hit.workspaceId, await historyKeyChain(deps, hit));
}

/**
 * Скачать снимок истории, если путь принадлежит `.history/` этого файла
 * (включая прежние канонические имена цепочки). Декодируется decrypt + gunzip
 * как у текущего файла по `_meta.wireGzip`.
 */
export async function downloadHistorySnapshot(
  deps: TrackedBlobReaderDeps,
  posixRel: string,
  historyCloudPath: string,
): Promise<Buffer> {
  const { hit, wireGzip } = await trackedReadContext(deps, posixRel);
  const chain = await historyKeyChain(deps, hit);
  if (!historyPathOwnedByChain(hit.workspaceId, chain, historyCloudPath)) {
    throw new Error("not a history path for this file");
  }
  return deps.decode(await downloadCloudBytes(deps, historyCloudPath.replace(/\/$/, "")), wireGzip);
}

/** Raw cloud bytes for a tracked file decoded to canonical plaintext (decrypt + optional gunzip). */
export async function downloadTrackedBlobPlaintext(
  deps: TrackedBlobReaderDeps,
  posixRel: string,
): Promise<{ body: Buffer }> {
  const { hit, key, wireGzip } = await trackedReadContext(deps, posixRel);
  const path = blobCloudPath(hit.workspaceId, key, wireGzip);
  return { body: deps.decode(await downloadCloudBytes(deps, path), wireGzip) };
}
