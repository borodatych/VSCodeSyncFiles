/**
 * Canonical path editing — the cloud-side relocation of blob bytes, `_meta`
 * rows and `.history/` snapshots that accompanies a manifest key move
 * (docs/v3/canonicalPaths.md). Extracted from the engine for its line ceiling;
 * the engine passes its codec/hash closures in.
 *
 * Every blob is TRANSCODED, not byte-copied: the target key re-decides the
 * gzip wire form, the `.gz` path suffix and — the load-bearing part — the
 * hashing category (text ↔ binary by extension), so `_meta.hash` is
 * recomputed from the same plaintext under the NEW key. A verbatim `_meta`
 * move would leave a hash no machine can reproduce after an extension change,
 * and every replica would look eternally diverged.
 *
 * Order matters and the caller owns it: relocate blobs first, PUT the
 * manifest, PUT `_meta`, and delete the old blobs STRICTLY last (this module
 * only returns their paths). An interrupted job must never leave a manifest
 * pointing at deleted bytes; re-running the whole sequence is idempotent.
 */
import type { ICloudProvider } from "../../providers/cloudProviderTypes.js";
import { ProviderError } from "../../providers/cloudProviderTypes.js";
import {
  historyDirForFile,
  type CloudManifest,
  type ManifestFile,
  type MetaEntry,
  type MetaJson,
} from "../cloudLayout.js";
import {
  manifestWithRenamedKeys,
  remapKeyThroughPrefixMoves,
  type CanonicalMove,
  type RenamedKeysResult,
} from "../canonicalRename.js";
import {
  planCanonicalRename,
  type CanonicalRenameRequest,
} from "../plan/planCanonicalRename.js";
import { manifestKeyOf } from "../trackedPathResolver.js";
import type { WorkspaceConfig } from "../types.js";
import { blobCloudPath } from "../wireCompression.js";
import { isProbablyBinaryPath } from "../../utils/binary.js";
import { warnLog } from "../../utils/log.js";

export interface RelocateBlobsDeps {
  workspaceId: string;
  provider: ICloudProvider;
  moves: readonly CanonicalMove[];
  /** Mutated in place: rows move `from` → `to` with recomputed hash/etag. */
  meta: MetaJson;
  nowIso: string;
  machineId: string;
  decode: (body: Buffer, wireGzip: boolean) => Buffer;
  encodeFor: (posixRel: string, plaintext: Buffer) => { body: Buffer; wireGzip: boolean; cloudPath: string };
  hashFor: (plaintext: Buffer, posixRel: string) => string;
  abortSignal?: AbortSignal;
  onUploadBytes?: (bytes: number) => void;
}

/**
 * Copy every move's blob to its new key (transcoded) and move its `_meta` row.
 * Returns the OLD blob paths for the caller to delete after both cloud
 * documents are safely written. A missing source blob is a metadata-only move
 * (the file may never have been pushed); its stale `_meta` row is dropped
 * rather than carried to a key it does not describe.
 */
export async function relocateBlobsForMoves(deps: RelocateBlobsDeps): Promise<string[]> {
  const oldBlobPaths: string[] = [];
  for (const move of deps.moves) {
    const metaRow = deps.meta.files[move.from];
    const wireGzip = metaRow?.wireGzip === true;
    const oldCloudPath = blobCloudPath(deps.workspaceId, move.from, wireGzip);
    // Fast path: when the hashing category holds, the wire form is identical
    // under the new key — a provider-native move relocates metadata only, no
    // download+upload of the whole blob. The `_meta` row carries over with the
    // move's fresh etag; the hash cannot change (same bytes, same
    // canonicalisation rules).
    if (
      metaRow !== undefined &&
      deps.provider.moveFile &&
      isProbablyBinaryPath(move.from) === isProbablyBinaryPath(move.to)
    ) {
      try {
        const moved = await deps.provider.moveFile(
          oldCloudPath,
          blobCloudPath(deps.workspaceId, move.to, wireGzip),
        );
        deps.meta.files[move.to] = {
          ...metaRow,
          etag: moved.etag ?? "",
          machineId: deps.machineId,
          updatedAt: deps.nowIso,
          version: Math.max(metaRow.version, deps.meta.files[move.to]?.version ?? 0) + 1,
        };
        deps.meta.files = Object.fromEntries(
          Object.entries(deps.meta.files).filter(([key]) => key !== move.from),
        );
        continue;
      } catch (e) {
        if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
          warnLog(
            "canonicalRelocation",
            `native move failed for ${move.from}, falling back to copy: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // NOT_FOUND falls through to the copy path, which treats a missing
        // source as a metadata-only move.
      }
    }
    let plaintext: Buffer | undefined;
    try {
      const dl = await deps.provider.downloadFile(oldCloudPath, { signal: deps.abortSignal });
      plaintext = deps.decode(dl.body, wireGzip);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
    }
    if (plaintext !== undefined) {
      const encoded = deps.encodeFor(move.to, plaintext);
      const uploaded = await deps.provider.uploadFile(encoded.cloudPath, encoded.body, {
        signal: deps.abortSignal,
      });
      deps.onUploadBytes?.(encoded.body.length);
      const nextRow: MetaEntry = {
        hash: deps.hashFor(plaintext, move.to),
        etag: uploaded.etag ?? "",
        version: Math.max(metaRow?.version ?? 0, deps.meta.files[move.to]?.version ?? 0) + 1,
        machineId: deps.machineId,
        updatedAt: deps.nowIso,
      };
      if (encoded.wireGzip) {
        nextRow.wireGzip = true;
      }
      deps.meta.files[move.to] = nextRow;
      oldBlobPaths.push(oldCloudPath);
    }
    if (metaRow !== undefined) {
      deps.meta.files = Object.fromEntries(
        Object.entries(deps.meta.files).filter(([key]) => key !== move.from),
      );
    }
  }
  return oldBlobPaths;
}

export interface CanonicalRelocationDeps {
  workspaceId: string;
  requests: readonly CanonicalRenameRequest[];
  provider: ICloudProvider;
  machineId: string;
  downloadManifest: () => Promise<CloudManifest | null>;
  pullMeta: () => Promise<MetaJson>;
  /** Owns the etag bookkeeping (`currentManifestEtag` + 412-merge cycle). */
  putManifest: (manifest: CloudManifest) => Promise<void>;
  /** The manifest as finally written (post 412-merge), if cached. */
  peekManifest: () => CloudManifest | undefined;
  /** Owns the meta etag reload. */
  pushMeta: (meta: MetaJson) => Promise<void>;
  /** Some of this batch's heirs lost a concurrent race — surface, never swallow. */
  onOverridden?: (moves: readonly CanonicalMove[]) => void;
  nextManifestVersion: (files: ManifestFile[]) => number;
  touchMachines: (machines: CloudManifest["machines"], now: string) => CloudManifest["machines"];
  decode: (body: Buffer, wireGzip: boolean) => Buffer;
  encodeFor: (posixRel: string, plaintext: Buffer) => { body: Buffer; wireGzip: boolean; cloudPath: string };
  hashFor: (plaintext: Buffer, posixRel: string) => string;
  loadCfg: () => Promise<WorkspaceConfig>;
  saveCfg: (cfg: WorkspaceConfig) => Promise<void>;
  /** This machine's scope prefixes, or undefined when the whole workspace syncs. */
  syncScopes: readonly string[] | undefined;
  patchSyncScopes: (scopes: string[]) => Promise<void>;
  abortSignal?: AbortSignal;
  onUploadBytes?: (bytes: number) => void;
}

/**
 * The whole cloud-side key move, in the one safe order: transcode blobs →
 * move history → ONE manifest PUT (tombstone + heir pairs, single batch
 * version, folder rules migrated) → `_meta` PUT → delete old blobs STRICTLY
 * last → re-point local rows (`manifestPath` moves, `localPath` — the bytes —
 * stays) and remap this machine's scope prefixes. Extracted from the engine
 * for its line ceiling; each step is idempotent, so re-running the same
 * requests resumes an interrupted job.
 */
export async function runCanonicalKeyRelocation(deps: CanonicalRelocationDeps): Promise<RenamedKeysResult> {
  const remoteManifest = await deps.downloadManifest();
  if (!remoteManifest) {
    throw new Error("manifest missing on cloud");
  }
  const plan = planCanonicalRename(remoteManifest.files, deps.requests);
  // A missing source usually means a resumed job already moved the row; every
  // other problem is a real refusal the UI should have prevented.
  const fatal = plan.problems.find((p) => p.kind !== "missing-source");
  if (fatal) {
    throw new Error(`переезд отклонён: ${JSON.stringify(fatal)}`);
  }
  if (plan.moves.length === 0) {
    return { manifest: remoteManifest, applied: [], skipped: [], batchVersion: 0 };
  }
  const meta = await deps.pullMeta();
  const now = new Date().toISOString();

  const oldBlobPaths = await relocateBlobsForMoves({
    workspaceId: deps.workspaceId,
    provider: deps.provider,
    moves: plan.moves,
    meta,
    nowIso: now,
    machineId: deps.machineId,
    decode: deps.decode,
    encodeFor: deps.encodeFor,
    hashFor: deps.hashFor,
    abortSignal: deps.abortSignal,
    onUploadBytes: deps.onUploadBytes,
  });

  await moveHistoryDirs(deps.provider, deps.workspaceId, plan.moves);

  const renamed = manifestWithRenamedKeys({
    manifest: remoteManifest,
    moves: plan.moves,
    prefixMoves: plan.prefixMoves,
    nowIso: now,
    nextVersion: deps.nextManifestVersion(remoteManifest.files),
    touchMachines: deps.touchMachines,
  });
  await deps.putManifest(renamed.manifest);
  // A 412-merge inside putManifest may have decided against some of this
  // batch's heirs (a concurrent rename won by Lamport, the duplicate-linkId
  // repair tombstoned ours). Losing silently would discard user intent.
  const finalManifest = deps.peekManifest();
  if (finalManifest && deps.onOverridden) {
    const liveFinal = new Set(finalManifest.files.filter((f) => !f.removedAt).map((f) => f.path));
    const overridden = renamed.applied.filter((m) => !liveFinal.has(m.to));
    if (overridden.length > 0) {
      deps.onOverridden(overridden);
    }
  }
  await deps.pushMeta(meta);

  // Old blobs go last: an interrupted job may leave orphan copies (resumable,
  // GC-able) but never a manifest pointing at deleted bytes.
  for (const oldPath of oldBlobPaths) {
    try {
      await deps.provider.deleteFile(oldPath);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
    }
  }

  // Local rows follow BY KEY: `manifestPath` re-points, the bytes stay put —
  // the product invariant "данные двигает пользователь".
  const appliedByFrom = new Map(renamed.applied.map((m) => [m.from, m]));
  const heirByPath = new Map(renamed.manifest.files.map((f) => [f.path, f]));
  const finalCfg = await deps.loadCfg();
  for (let i = 0; i < finalCfg.files.length; i++) {
    const f = finalCfg.files[i];
    if (f.workspaceId !== deps.workspaceId) continue;
    const move = appliedByFrom.get(manifestKeyOf(f));
    if (!move) continue;
    const heir = heirByPath.get(move.to);
    finalCfg.files[i] = {
      ...f,
      manifestPath: move.to === f.localPath ? undefined : move.to,
      cloudPath: blobCloudPath(deps.workspaceId, move.to, meta.files[move.to]?.wireGzip === true),
      ...(heir?.linkId !== undefined ? { linkId: heir.linkId } : {}),
    };
  }
  await deps.saveCfg(finalCfg);
  // A renamed folder must not silently drop out of this machine's scopes.
  if (plan.prefixMoves.length > 0 && deps.syncScopes !== undefined && deps.syncScopes.length > 0) {
    await deps.patchSyncScopes(
      deps.syncScopes.map((s) => remapKeyThroughPrefixMoves(s, plan.prefixMoves)),
    );
  }
  return renamed;
}

/**
 * `.history/` snapshots follow the file, best-effort: a provider hiccup here
 * must not fail the rename — history is a convenience trail, and before this
 * existed every rename simply orphaned it.
 */
export async function moveHistoryDirs(
  provider: ICloudProvider,
  workspaceId: string,
  moves: readonly CanonicalMove[],
): Promise<void> {
  for (const move of moves) {
    try {
      const entries = await provider.listFolder(historyDirForFile(workspaceId, move.from));
      for (const entry of entries) {
        const name = entry.cloudPath.split("/").pop();
        if (name === undefined || name === "") continue;
        const dl = await provider.downloadFile(entry.cloudPath);
        await provider.uploadFile(`${historyDirForFile(workspaceId, move.to)}/${name}`, dl.body);
        await provider.deleteFile(entry.cloudPath);
      }
    } catch (e) {
      warnLog(
        "canonicalRelocation",
        `history move skipped for ${move.from}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
