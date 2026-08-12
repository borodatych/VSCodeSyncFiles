import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  WorkspaceConfig,
  TrackedFile,
  ActiveWorkspaceEntry,
  WorkspaceSyncState,
} from "./types.js";
import { normalizeWorkspaceSyncState } from "./types.js";
import { WorkspaceConfigManager } from "./workspaceConfigManager.js";
import { getWorkspaceConfigStore, type WorkspaceConfigStore } from "./io/workspaceConfigStore.js";
import type { CloudManifest, ManifestFile, MetaJson, MachineEntry, MetaEntry } from "./cloudLayout.js";
import {
  EMPTY_META_JSON,
  historyDirForFile,
  manifestCloudPath,
  metaCloudPath,
  SUPPORTED_MANIFEST_SCHEMA,
  sharedIgnorePatternsOrEmpty,
  workspaceRootPath,
} from "./cloudLayout.js";
import { canonicalKeyForLocalPath, localPathForCanonicalKey, normalizeDirPrefix } from "./folderBindings.js";
import { defaultLinkName, findDuplicateLinkIds, newLinkId, rebuildManifestFilesFromTracked } from "./linkIdentity.js";
import { touchManifestMachine } from "./machineRegistry.js";
import { manifestKeyOf } from "./trackedPathResolver.js";
import { mergeCloudManifests, mergeMachinesPreferNewer, mergeManifestFiles } from "./manifestMerger.js";
import { copyCloudFileBetweenProviders } from "./cloudMigration.js";
import { createWorkspaceSnapshot, type SnapshotCrypto } from "./snapshotsEngine.js";
import { backupLocalWithPrune, LOCAL_BACKUP_DIR_DEFAULT } from "./localFileBackup.js";
import { mergeMetaEntries } from "./metaMerge.js";
import { createMetaStore, type MetaStore, type MetaWriteReason } from "./io/metaStore.js";
import { createHistoryStore, type HistoryStore, type LazyHistoryEntry } from "./io/historyStore.js";
import { createBlobTransfer, type BlobTransfer } from "./io/blobTransfer.js";
import { listRemoteWorkspaceSummaries } from "./cloudWorkspaceLister.js";
import { deleteCloudFolderRecursive } from "./io/deleteCloudFolder.js";
import { createManifestStore, type ManifestStore } from "./io/manifestStore.js";
import type { ChangeAction } from "./changeDetection.js";
import { BindRejectedError, planBindLocalFile } from "./plan/planBindLocalFile.js";
import { planCloudScanRepair } from "./plan/planCloudScanRepair.js";
import { applyWorkspaceMergeToCfg } from "./plan/planWorkspaceMergeCfg.js";
import { entryPatchFromManifest, manifestMachineCache } from "./manifestCacheFields.js";
import { runBlake3BackfillTasks } from "./plan/planBlake3Backfill.js";
import { runBindingSelfHeal } from "./bindingSelfHealState.js";
import { isInSyncScope, normalizeSyncScopes } from "./syncScope.js";
import {
  manifestWithFolderRule,
  manifestWithLinkName,
  replaceStrandedRows,
  tombstoneManifestKey,
} from "./folderBindingOps.js";
import { buildSyncPreview } from "./syncPreview.js";
import { planFileAction, syncStatusForAction } from "./plan/planFileAction.js";
import { parallelLimit } from "./parallelLimit.js";
import type { FileMetadata, ICloudProvider } from "../providers/cloudProviderTypes.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import {
  hashCanonicalBuffer,
  hashCanonicalBufferDual,
  type HashConfig,
} from "../utils/hash.js";
import { verboseLog, warnLog } from "../utils/log.js";
import { detectMassChange } from "./massChangeGuard.js";
import { preserveConflictSharesLfCanonical } from "./preserveLineEndingConflict.js";
import { mergeSyncignoreFromCloud, extractSyncignoreInners } from "../utils/syncignore.js";
import { normalizeIgnorePatternStrings } from "../utils/ignorePatternNormalize.js";
import { absoluteToTrackedPosix, trackedLocalAbsolutePath } from "./pathMapping.js";
import { assertMutationAllowed, mutationPolicy, type MutationOp } from "./syncPolicy.js";
import { runWithSyncFileLock } from "./syncFileLock.js";
import {
  isSecondaryWorkspaceInstanceReadOnly,
  rejectIfSecondaryWorkspaceInstanceReadOnly,
} from "./syncWorkspaceInstanceReadOnly.js";
import type { ActivityEventInput } from "./activityLog.js";
import type { SyncTransferEvent } from "./syncStatsStore.js";
import {
  blobCloudPath,
} from "./wireCompression.js";
import { fileLooksBinary } from "../utils/binaryDetect.js";
import { planUploadEncoding } from "./plan/planUploadEncoding.js";
import { planTrackingDiff } from "./plan/planTrackingDiff.js";
import { throwIfAborted } from "./operationCancelled.js";
import { applyLockChange, findStaleLocks } from "./softLockAdmin.js";
import { bufferLooksBinary } from "../utils/binary.js";

const HISTORY_VERSIONS_DEFAULT = 10;
const META_WRITE_RETRIES_DEFAULT = 3;
const VERIFY_RETRIES_DEFAULT = 3;
const TOMBSTONE_PURGE_DAYS_DEFAULT = 30;
const FILE_CONCURRENCY_DEFAULT = 1;
const WORKSPACE_CONCURRENCY_DEFAULT = 1;
/**
 * When a no-op sync confirms that local and cloud already match, refresh
 * `file.lastSync` to "now" if the existing value is older than this. Keeps
 * background watch-tick I/O down (skips when already fresh) while ensuring
 * a user-initiated Push All / Pull All / Sync revives the workspace health
 * indicator even when nothing was actually transferred.
 */
const LAST_SYNC_REFRESH_THROTTLE_MS = 5 * 60_000;

/**
 * Minimal glob matcher for conflict rules.
 * Supports `*` (within one path segment) and `**` (any depth).
 */

/** Soft lock (`ManifestFile.editingSince`) older than this is stale (Health Check / repair). */
export const STALE_MANIFEST_EDITING_LOCK_MS_DEFAULT = 3 * 3600_000;
/** Backwards-compat alias — engine callers can still read the default directly. */
export const STALE_MANIFEST_EDITING_LOCK_MS = STALE_MANIFEST_EDITING_LOCK_MS_DEFAULT;

/**
 * Cloud manifest could not be parsed.
 *
 * Distinct from "manifest absent": absence means the workspace was deleted
 * elsewhere and local detach is correct, whereas a corrupt body means we simply
 * do not know, and destroying local tracking over it is never right.
 */
/**
 * Operation denied by a workspace-level rule, not by anything about the file.
 *
 * Suspend / freeze, a machine still awaiting approval, a read-only secondary
 * window — these apply to every file of the workspace equally. `pushAll`
 * isolates *per-file* failures so one unreadable file cannot abort the rest;
 * without this type a policy denial would be recorded once per file and the
 * workspace would still report success.
 */
/**
 * The file is in conflict and neither side may be moved until it is resolved.
 *
 * `pushFile` used to return silently here while `pullFile` threw a bare `Error`.
 * The same user action therefore produced either a false "done" or an
 * exception, depending on direction.
 */
export class FileConflictError extends Error {
  constructor(readonly posixRel: string) {
    super(
      `VSCodeSync: «${posixRel}» в конфликте — синхронизация файла остановлена. ` +
        "Разрешите конфликт: «Принять моё» или «Принять их версию».",
    );
    this.name = "FileConflictError";
  }
}

export class WorkspacePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePolicyError";
  }
}

/**
 * Re-exported so existing importers keep working; the class itself now lives
 * with the code that throws it (`io/manifestStore`). Two separate classes with
 * the same name would make `instanceof` lie.
 */
export { ManifestCorruptError } from "./io/manifestStore.js";

/** Файл, потерявший синхронизацию: отслеживался локально, но исчез из облачного манифеста (tombstone очищен). */
export interface PurgeLostFileItem {
  workspaceId: string;
  workspaceNote: string;
  /** POSIX-относительный путь в пределах workspace root. */
  relPath: string;
}

/** Per-workspace outcome of `pushAll`. */
export interface PushAllResult {
  workspaceId: string;
  ok: boolean;
  /** Number of files actually pushed (after the local-hash check). */
  pushedFiles: number;
  /** When `ok === true` and the workspace was skipped (e.g. not in `activeWorkspaces`). */
  skipped?: "not_active";
  /** When `ok === false` — error message captured from the failing call. */
  error?: string;
  /**
   * Files that failed individually while the workspace as a whole succeeded.
   *
   * A single unreadable file used to reject the whole workspace: `computeHash`
   * throws ENOENT for a file deleted from disk since the last sync, the
   * `parallelLimit` callback rejected, and every remaining file in that
   * workspace was skipped. One stale entry blocked the entire push.
   */
  failedFiles?: { posixRel: string; error: string }[];
}

/** Progress event surfaced by `pushAll(_, onProgress)`. Two events per workspace. */
export type PushAllProgressEvent =
  | {
      kind: "workspace_started";
      workspaceId: string;
      workspaceNote: string;
      index: number;
      total: number;
    }
  | {
      kind: "workspace_finished";
      workspaceId: string;
      workspaceNote: string;
      index: number;
      total: number;
      ok: boolean;
      pushedFiles: number;
      error?: string;
    };

/** Действие по файлу в сухом прогоне sync (см. `previewSyncPlan`). */
export type PreviewSyncFileAction = ChangeAction | "conflict_pending";

export interface SyncPreviewFileRow {
  localPath: string;
  action: PreviewSyncFileAction;
}

export interface SyncPreviewWorkspace {
  workspaceId: string;
  workspaceNote: string;
  files: SyncPreviewFileRow[];
}

/**
 * The engine's dependency set, split into ports / config / events
 * (`engineDeps.ts`). Re-exported so existing importers keep working.
 */
export type {
  EnginePorts,
  EngineConfig,
  EngineEvents,
  SyncEngineDeps,
} from "./engineDeps.js";
import type { SyncEngineDeps } from "./engineDeps.js";

/** v0.7 — deferred history snapshot. Owned by `io/historyStore`. */
export type { LazyHistoryEntry } from "./io/historyStore.js";

/** v0.7 — single-file timing sample from `pushFile` / `pullFile`. */
export interface SyncProfileSample {
  kind: "push" | "pull";
  workspaceId: string;
  posixRel: string;
  bytes: number;
  /** Total wall-clock ms including hash, network, verify. */
  totalMs: number;
  /** Hashing CPU time (canonical hash). */
  hashMs: number;
  /** Upload / download ms only. */
  networkMs: number;
  /** Post-upload verification ms (0 when skipped). */
  verifyMs: number;
}

export class SyncEngine {
  /**
   * `manifest.json` I/O, its etag-matched cache and the 412-merge (этап 5.2).
   * Built on first use — a field initialiser would run before `deps` exists.
   */
  private manifestStoreRef: ManifestStore | undefined;

  private get manifestStore(): ManifestStore {
    this.manifestStoreRef ??= createManifestStore({
      provider: this.deps.provider,
      tombstonePurgeDays: () => this.deps.tombstonePurgeDays ?? TOMBSTONE_PURGE_DAYS_DEFAULT,
      onCorrupt: (workspaceId, reason) => this.deps.onCorruptManifest?.(workspaceId, reason),
      onEtag: (workspaceId, etag, manifest) =>
        this.patchEntry(workspaceId, {
          manifestEtag: etag,
          ...entryPatchFromManifest(manifest),
        }),
      currentEtag: async (workspaceId) =>
        (await this.loadCfg()).activeWorkspaces.find((w) => w.workspaceId === workspaceId)
          ?.manifestEtag,
      beforeWrite: async (workspaceId) => {
        this.assertMayMutate("putManifest");
        rejectIfSecondaryWorkspaceInstanceReadOnly();
        await this.ensureNotFrozenForCloudWrites(workspaceId);
      },
      onMassChange: this.deps.onMassChange
        ? (workspaceId, report) => this.deps.onMassChange!(workspaceId, report)
        : undefined,
    });
    return this.manifestStoreRef;
  }

  /** Cache a manifest body together with the etag that names it (if known). */
  private cacheManifest(workspaceId: string, manifest: CloudManifest, etag: string | undefined): void {
    this.manifestStore.cache(workspaceId, manifest, etag);
  }

  /**
   * The manifest etag as of the most recent download in this instance,
   * falling back to what the caller had. Callers that download and then write
   * must use this: `patchEntry` has already advanced the stored etag, and the
   * copy they loaded earlier is one write behind.
   */
  private async currentManifestEtag(
    workspaceId: string,
    fallback: string | undefined,
  ): Promise<string | undefined> {
    const fresh = (await this.loadCfg()).activeWorkspaces.find(
      (w) => w.workspaceId === workspaceId,
    )?.manifestEtag;
    return fresh ?? fallback;
  }

  private evictManifestCache(workspaceId: string): void {
    this.manifestStore.forget(workspaceId);
  }
  /**
   * `_meta.json` I/O and its in-memory copy (этап 5.2). Policy stays here: the
   * store calls back into `beforeWrite` for the mutation checks.
   *
   * Built on first use — a field initialiser would run before `deps` exists.
   */
  private metaStoreRef: MetaStore | undefined;

  private get metaStore(): MetaStore {
    this.metaStoreRef ??= createMetaStore({
      provider: this.deps.provider,
      metaWriteRetries: () => this.resolveMetaWriteRetries(),
      onEtag: (workspaceId, etag) => this.patchEntry(workspaceId, { metaEtag: etag }),
      beforeWrite: async (workspaceId, reason) => {
        this.assertMayMutate("pushMetaJson");
        // A secondary window may finish its own pull (recording what it just
        // downloaded); everything else is a cloud write it must not make.
        if (reason !== "pull-completion") {
          rejectIfSecondaryWorkspaceInstanceReadOnly();
        }
        await this.ensureNotFrozenForCloudWrites(workspaceId);
      },
    });
    return this.metaStoreRef;
  }
  /**
   * When set, `persistMutatedCfg(cfgRef)` only marks the batch dirty and
   * skips the disk write. Used by `syncWorkspace` / `forcePullWorkspace`
   * to coalesce N per-file writes into one flush at the end of the loop.
   * Mutation safety: parallel branches share the same cfg object, JS turns
   * are atomic between awaits, so mutations always reach the final flush.
   */
  private _batchCfgRef: WorkspaceConfig | null = null;
  private _batchCfgDirty = false;
  /** v0.7 — deferred history snapshots when `historyMode = lazy`. */
  /** `.history/` I/O and the deferred-snapshot queue (этап 5.2). */
  private historyStoreRef: HistoryStore | undefined;

  /** Blob-level cloud I/O (этап 5.2). */
  private blobTransferRef: BlobTransfer | undefined;

  private get blobTransfer(): BlobTransfer {
    this.blobTransferRef ??= createBlobTransfer({
      provider: this.deps.provider,
      decrypt: this.deps.decrypt,
      hashCfg: (posixRel) => this.hashCfg(posixRel),
      verifyRetries: () => this.resolveVerifyRetries(),
    });
    return this.blobTransferRef;
  }

  private get historyStore(): HistoryStore {
    this.historyStoreRef ??= createHistoryStore({
      provider: this.deps.provider,
      machineName: this.deps.machineName,
      mode: () => this.resolveHistoryMode(),
      versions: () => this.resolveHistoryVersions(),
      onQueued: (entry) => this.deps.onLazyHistoryQueued?.(entry),
    });
    return this.historyStoreRef;
  }
  /**
   * Files currently under a user-initiated pull/push/conflict-resolve.
   * Read by `iterateTrackedFiles` (check-only and full) to skip the file
   * while the cloud meta upload is still in flight — prevents the watcher
   * from rolling `syncStatus` back to `cloud_newer` between
   * `persistMutatedCfg` (local "ok") and `pushMetaJson` (cloud meta update).
   * Pure in-memory; never persisted; cleared in the operation's `finally`.
   */
  private readonly inFlightOps = new Set<string>();

  constructor(private readonly deps: SyncEngineDeps) {}

  /**
   * The mutation checkpoint (F2). First statement of every method listed in
   * `MutationOp`; throws `MutationDeniedError` when an automatic source tries
   * to move data. The policy is imported, not injected — see `syncPolicy.ts`.
   */
  /** Non-throwing form, for the few places that skip work instead of failing. */
  /** Cancellation for this operation, when the caller supplied one (A5). */
  private get abortSignal(): AbortSignal | undefined {
    return this.deps.abortSignal;
  }

  /** Stop between units of work rather than after everything in flight. */
  private assertNotCancelled(op: string): void {
    throwIfAborted(this.abortSignal, op);
  }

  private mayMutate(op: MutationOp): boolean {
    return mutationPolicy(op, this.deps.trigger) === "allow";
  }

  private assertMayMutate(op: MutationOp): void {
    if (this.mayMutate(op)) return;
    // Refusing a background source is the extension behaving correctly, so it
    // is a diagnostic line and not an error toast. Without it the symptom reads
    // as "the extension does nothing" with no trace of why.
    warnLog("syncPolicy", `deny ${op} (trigger=${this.deps.trigger})`);
    assertMutationAllowed(op, this.deps.trigger);
  }

  private inFlightKey(workspaceId: string, posixRel: string): string {
    return `${workspaceId}\u0000${posixRel}`;
  }

  /** True while a user-initiated pull/push/conflict-resolve holds the file. */
  private isOpInFlight(workspaceId: string, posixRel: string): boolean {
    return this.inFlightOps.has(this.inFlightKey(workspaceId, posixRel));
  }

  /**
   * Wrap a per-file operation so the watcher skips it for the duration.
   * Marker is set synchronously before the operation begins and removed in
   * `finally`, including the error path.
   */
  private async withInFlightOp<T>(
    workspaceId: string,
    posixRel: string,
    op: () => Promise<T>,
  ): Promise<T> {
    const key = this.inFlightKey(workspaceId, posixRel);
    this.inFlightOps.add(key);
    try {
      return await op();
    } finally {
      this.inFlightOps.delete(key);
    }
  }

  /** Read-only accessor for the bound provider. Used by UI helpers that
   *  need to issue raw provider calls (history scrub, cloud-open) without
   *  reaching into private `deps`. */
  getProvider(): ICloudProvider {
    return this.deps.provider;
  }

  /** v0.7 — read setting with default fallback (cheap to call inline). */
  private resolveFileConcurrency(): number {
    const raw = this.deps.syncFileConcurrency?.() ?? FILE_CONCURRENCY_DEFAULT;
    return Math.max(1, Math.min(32, raw | 0));
  }
  private resolveWorkspaceConcurrency(): number {
    const raw = this.deps.syncWorkspaceConcurrency?.() ?? WORKSPACE_CONCURRENCY_DEFAULT;
    return Math.max(1, Math.min(16, raw | 0));
  }
  private resolveHistoryVersions(): number {
    return Math.max(0, this.deps.historyVersions?.() ?? HISTORY_VERSIONS_DEFAULT);
  }
  private resolveMetaWriteRetries(): number {
    return Math.max(1, this.deps.metaWriteRetries?.() ?? META_WRITE_RETRIES_DEFAULT);
  }
  private resolveVerifyRetries(): number {
    return Math.max(1, this.deps.verifyRetries?.() ?? VERIFY_RETRIES_DEFAULT);
  }
  private resolveSoftLockStaleMs(): number {
    return Math.max(60_000, this.deps.softLockStaleMs?.() ?? STALE_MANIFEST_EDITING_LOCK_MS_DEFAULT);
  }
  private resolveLocalBackupDir(): string {
    return this.deps.localBackupDir?.() ?? LOCAL_BACKUP_DIR_DEFAULT;
  }

  /** Snapshot blobs use the engine's own encryption context. */
  private snapshotCrypto(): SnapshotCrypto {
    return {
      required: this.deps.encryptionRequired === true,
      encrypt: this.deps.encrypt,
      decrypt: this.deps.decrypt,
    };
  }
  private resolveHistoryMode(): "inline" | "lazy" | "off" {
    return this.deps.historyMode?.() ?? "inline";
  }
  private resolveVerifyUploadHash(): "plaintext-only" | "never" {
    return this.deps.verifyUploadHash?.() ?? "plaintext-only";
  }
  private resolveProviderHashVerify(): boolean {
    return this.deps.providerHashVerify?.() ?? false;
  }

  /**
   * v0.7 — coalesce-aware persistence. When called with the cfg object that
   * the engine is currently batching, marks it dirty and returns immediately.
   * Otherwise writes through immediately (callers passing their own cfg).
   *
   * **When to use `persistMutatedCfg` vs `saveCfg`:**
   * - `persistMutatedCfg` — mutations made inside `syncOneFile` / `pushFile` /
   *   `pullFile` / `reconcileBeforePushUpload` / conflict marking. These are
   *   driven by `iterateTrackedFiles` under `withBatchedCfgWrites`, so the
   *   write coalesces into one flush per workspace.
   * - `saveCfg` (direct) — top-level user-driven mutations (lifecycle ops:
   *   attach / detach / createWorkspace / patchEntry / addFiles / rename /
   *   resolveConflictKeepMine) and epoch boundaries before/after the
   *   batched section (adoptManifestFilesFromCloud, pruneTrackingFromManifest).
   *   These run outside any batch, so writes are immediate.
   *
   * The 17 surviving direct `saveCfg` call sites are intentional and audited
   * (v0.8 audit). Do not "fix" them by rerouting through `persistMutatedCfg`
   * — without an active `_batchCfgRef === c` match, that's a no-op.
   */
  private async persistMutatedCfg(c: WorkspaceConfig): Promise<void> {
    if (this._batchCfgRef !== null && this._batchCfgRef === c) {
      this._batchCfgDirty = true;
      return;
    }
    await this.saveCfg(c);
  }

  /** v0.7 — run `fn` with a cfg-write batch. One flush at the end if dirty. */
  private async withBatchedCfgWrites<T>(c: WorkspaceConfig, fn: () => Promise<T>): Promise<T> {
    const prevRef = this._batchCfgRef;
    const prevDirty = this._batchCfgDirty;
    this._batchCfgRef = c;
    this._batchCfgDirty = false;
    try {
      return await fn();
    } finally {
      // The `await fn()` above may flip `_batchCfgDirty` through any of the
      // engine's mutation paths; TS doesn't model that side-effect, so the
      // narrow-to-`false` from the initialiser at the top of this method
      // would otherwise leak in here. Cast-through-boolean keeps the lint
      // honest about what we actually read.
      const dirty = this._batchCfgDirty as boolean;
      this._batchCfgRef = prevRef;
      this._batchCfgDirty = prevDirty;
      if (dirty) {
        try {
          await this.saveCfg(c);
        } catch (e) {
          warnLog("syncEngine", `batched saveCfg failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  /**
   * v0.7 — drain the lazy history queue. Host calls this on a timer; engine
   * returns and clears all queued snapshots. Caller is responsible for
   * actually uploading them via `runDeferredHistorySnapshots`.
   */
  drainLazyHistoryQueue(): LazyHistoryEntry[] {
    return this.historyStore.drain();
  }

  /** v0.7 — execute queued history snapshots from a prior drain. */
  async runDeferredHistorySnapshots(entries: readonly LazyHistoryEntry[]): Promise<void> {
    this.assertMayMutate("runDeferredHistorySnapshots");
    for (const e of entries) {
      try {
        await this.historyStore.snapshotNow(e.workspaceId, e.posixRel, e.oldCloudPath);
      } catch (err) {
        warnLog("syncEngine", `lazy history snapshot failed (${e.workspaceId}/${e.posixRel}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private fireActivity(ev: ActivityEventInput): void {
    this.deps.onSyncActivity?.(ev);
  }

  private emitTransfer(ev: SyncTransferEvent): void {
    this.deps.onTransfer?.(ev);
  }

  /** Suspend / Freeze / Resume — локально в `vscodesync.json` (`syncState`). `active` снимает поле. */
  async setWorkspaceSyncState(workspaceId: string, next: WorkspaceSyncState): Promise<void> {
    await this.patchEntry(workspaceId, {
      syncState: next === "active" ? undefined : next,
    });
  }

  /** Suspend/Freeze блокируют любые операции с файлами (pull и push). */
  private async ensureWorkspaceNotSuspendedNorFrozen(workspaceId: string): Promise<void> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const st = normalizeWorkspaceSyncState(entry);
    if (st === "suspended") {
      throw new WorkspacePolicyError("Workspace в режиме Suspend: загрузка и выгрузка файлов отключены.");
    }
    if (st === "frozen") {
      throw new WorkspacePolicyError("Workspace заморожен (Freeze): операции с файлами отключены.");
    }
  }

  /** Upload/delete файлов и метаданных при включённом одобрении машин — только если машина не pending/blocked в манифесте. */
  private async ensureWorkspaceMayUploadFiles(workspaceId: string): Promise<void> {
    await this.ensureWorkspaceNotSuspendedNorFrozen(workspaceId);
    if (this.deps.requireMachineApproval?.() !== true) {
      return;
    }
    // v0.18 D06 — trusted teammate bypass. When the user has explicitly
    // marked this machine as trusted (via the trustedMachinesRegistry),
    // skip the pending/blocked check.
    if (this.deps.isTrustedTeammate?.(this.deps.machineId) === true) {
      return;
    }
    const st = await this.getSelfMachineStatusInManifest(workspaceId);
    if (st === "pending") {
      throw new WorkspacePolicyError(
        "Workspace: эта машина ожидает подтверждения в манифесте — отправка и изменение состава файлов отключены (выполните Pull или дождитесь одобрения на другой машине).",
      );
    }
    if (st === "blocked") {
      throw new WorkspacePolicyError("Workspace: машина заблокирована в манифесте — запись отключена.");
    }
  }

  /** Pull-only path: разрешён при pending/blocked (загрузка с облака). */
  private async shouldSkipPushDueToMachineApproval(workspaceId: string): Promise<boolean> {
    if (this.deps.requireMachineApproval?.() !== true) {
      return false;
    }
    // v0.18 D06 — trusted teammate never blocked.
    if (this.deps.isTrustedTeammate?.(this.deps.machineId) === true) {
      return false;
    }
    const st = await this.getSelfMachineStatusInManifest(workspaceId);
    return st === "pending" || st === "blocked";
  }

  /** Freeze блокирует PUT манифеста и `_meta.json`. Suspend манифест на облако всё ещё может обновляться (кроме операций с файлами). */
  private async ensureNotFrozenForCloudWrites(workspaceId: string): Promise<void> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    if (normalizeWorkspaceSyncState(entry) === "frozen") {
      throw new Error("Workspace заморожен (Freeze): запись манифеста и _meta отключена.");
    }
  }

  /**
   * Canonical hash of a tracked file's on-disk bytes, keyed by its MANIFEST
   * key: binary-vs-text detection runs on the path, so a bound file renamed
   * locally must still hash by the name every other machine agrees on.
   */
  private async hashTrackedFile(abs: string, manifestKey: string): Promise<string> {
    const buf = await fs.readFile(abs);
    return hashCanonicalBuffer(buf, manifestKey, this.hashCfg(manifestKey));
  }

  private hashCfg(trackedPosix?: string): HashConfig {
    const lineEnding = this.deps.lineEnding ?? "lf";
    const encodingLint = this.deps.encodingLint !== false;
    const rel = trackedPosix ?? "";
    const oe = this.deps.onEncodingIssue;
    const onTextEncodingIssue =
      encodingLint && rel !== "" && oe
        ? (kind: "bom" | "invalid_utf8") => {
            oe(kind, rel);
          }
        : undefined;
    return { lineEnding, encodingLint, onTextEncodingIssue };
  }

  /** При конфликте и lineEnding=preserve: если расхождение только из-за переводов строк (совпадение LF-хэша). */
  private async notifyPreserveLineEndingConflictIfNeeded(
    cfg: WorkspaceConfig,
    file: TrackedFile,
    cloudBuf: Buffer | undefined,
    localCurrent: string,
    cloudCurrent: string,
  ): Promise<void> {
    if (this.deps.lineEnding !== "preserve" || cloudBuf === undefined) {
      return;
    }
    if (localCurrent === cloudCurrent) {
      return;
    }
    const abs = this.localAbs(cfg, file.localPath);
    const localBuf = await fs.readFile(abs);
    const baseCfg = this.hashCfg(manifestKeyOf(file));
    if (!preserveConflictSharesLfCanonical(localBuf, cloudBuf, manifestKeyOf(file), baseCfg)) {
      return;
    }
    this.deps.onPreserveLineEndingConflictHint?.(file.localPath);
  }

  /**
   * When `lineEnding=preserve`, same UTF-8 text with only EOL divergence → keep local bytes (push) instead of conflict.
   */
  private async tryAutoResolvePreserveLineEndingConflict(
    cfg: WorkspaceConfig,
    workspaceId: string,
    file: TrackedFile,
    entry: ActiveWorkspaceEntry,
    cloudBuf: Buffer | undefined,
    localCurrent: string,
    cloudCurrent: string,
  ): Promise<boolean> {
    if (this.deps.lineEnding !== "preserve" || cloudBuf === undefined) {
      return false;
    }
    if (localCurrent === cloudCurrent) {
      return false;
    }
    const abs = this.localAbs(cfg, file.localPath);
    const localBuf = await fs.readFile(abs);
    if (!preserveConflictSharesLfCanonical(localBuf, cloudBuf, manifestKeyOf(file), this.hashCfg(manifestKeyOf(file)))) {
      return false;
    }
    if (isSecondaryWorkspaceInstanceReadOnly()) {
      return false;
    }
    if (await this.shouldSkipPushDueToMachineApproval(workspaceId)) {
      return false;
    }
    await this.pushFile(cfg, workspaceId, file.localPath, entry, { asAutoResolvedKeepMine: true });
    return file.syncStatus !== "conflict";
  }

  /** Имена папок первого уровня под `VSCodeSyncFiles/` (mock провайдер отдаёт вложенные пути — тоже работает). */
  /**
   * Сканирует корень облака и возвращает манифесты workspace'ов с поддерживаемой схемой.
   */
  /**
   * Returns the list of tracked file paths (posix-relative) from a cloud workspace manifest.
   * Used for overlap detection before attachCloudWorkspace.
   * Only returns non-tombstoned files.
   */
  async listCloudWorkspaceFiles(workspaceId: string): Promise<string[]> {
    const dl = await this.deps.provider.downloadFile(manifestCloudPath(workspaceId));
    const m = JSON.parse(dl.body.toString("utf8")) as { files?: { path: string; removedAt?: string }[] };
    if (!Array.isArray(m.files)) return [];
    return m.files.filter((f) => !f.removedAt).map((f) => f.path);
  }

  /**
   * Repair mode: scan cloud folder for blobs when the manifest is corrupted/absent.
   * Lists `VSCodeSyncFiles/{workspaceId}/`, filters out meta/history/snapshot entries,
   * reconstructs a minimal `_meta.json` and updates `vscodesync.json`.
   * Returns the list of discovered file paths (posix-relative to workspace root).
   */
  async repairByCloudScan(workspaceId: string): Promise<string[]> {
    this.assertMayMutate("repairByCloudScan");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const root = workspaceRootPath(workspaceId);
    const listed = await this.deps.provider.listFolder(root);
    // Blob detection + placeholder meta live in `planCloudScanRepair` (pure).
    const { paths, reconstructedMeta } = planCloudScanRepair(
      root,
      listed,
      this.deps.machineId,
      new Date().toISOString(),
    );
    if (paths.length === 0) {
      return [];
    }

    // Write reconstructed _meta.json to cloud
    await this.deps.provider.uploadFile(
      metaCloudPath(workspaceId),
      Buffer.from(`${JSON.stringify(reconstructedMeta, null, 2)}\n`, "utf8"),
    );
    this.metaStore.put(workspaceId, reconstructedMeta);

    // Update local config to record that this workspace has been scanned
    const cfg = await this.loadCfg();
    const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === workspaceId);
    if (ix >= 0) {
      cfg.activeWorkspaces[ix] = { ...cfg.activeWorkspaces[ix] };
      await this.saveCfg(cfg);
    }

    return paths;
  }

  /** Delegates to `listRemoteWorkspaceSummaries` (cloudWorkspaceLister.ts). */
  async listRemoteWorkspaceSummaries(): Promise<{ workspaceId: string; workspaceNote: string }[]> {
    return listRemoteWorkspaceSummaries(this.deps.provider, SUPPORTED_MANIFEST_SCHEMA);
  }

  /**
   * Подключить workspace с облака: локальный `activeWorkspaces`, регистрация машины в манифесте,
   * трекинг файлов из манифеста и sync (pull при необходимости).
   */
  async attachCloudWorkspace(workspaceId: string): Promise<void> {
    this.assertMayMutate("attachCloudWorkspace");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg0 = await this.loadCfg();
    if (cfg0.activeWorkspaces.some((w) => w.workspaceId === workspaceId)) {
      throw new Error("этот workspace уже подключён к проекту");
    }
    const manifestDl = await this.deps.provider.downloadFile(manifestCloudPath(workspaceId));
    const probe = JSON.parse(manifestDl.body.toString("utf8")) as {
      schemaVersion?: number;
      workspaceId?: string;
    };
    if (probe.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
      // v0.18 W3 — let the UI offer migration when callback wired; default
      // (no callback) is the legacy throw-on-mismatch behaviour.
      const detected = typeof probe.schemaVersion === "number" ? probe.schemaVersion : -1;
      const decision = this.deps.onSchemaVersionMismatch
        ? await this.deps.onSchemaVersionMismatch(workspaceId, detected, SUPPORTED_MANIFEST_SCHEMA)
        : "abort";
      if (decision === "abort") {
        throw new Error(`облачный манифест: неподдерживаемая schemaVersion ${String(probe.schemaVersion)}`);
      }
      // "migrate" path: caller has scheduled the migration job; we exit
      // gracefully here so it can run before re-attempting attach.
      return;
    }
    if (probe.workspaceId !== workspaceId) {
      throw new Error("workspaceId в манифесте не совпадает с папкой на облаке");
    }
    const manifest = JSON.parse(manifestDl.body.toString("utf8")) as CloudManifest;

    let metaEtag: string | undefined;
    let meta: MetaJson;
    try {
      const metaDl = await this.deps.provider.downloadFile(metaCloudPath(workspaceId));
      meta = JSON.parse(metaDl.body.toString("utf8")) as MetaJson;
      metaEtag = metaDl.etag;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        meta = { files: {} };
        metaEtag = undefined;
      } else {
        throw e;
      }
    }

    cfg0.activeWorkspaces.push({
      workspaceId,
      workspaceNote: manifest.workspaceNote,
      tags: manifest.tags,
      gitBranch: manifest.gitBranch,
      sharedIgnorePatterns: sharedIgnorePatternsOrEmpty(manifest),
      providerType: manifest.providerType,
      manifestMachines: manifestMachineCache(manifest),
      manifestEtag: manifestDl.etag,
      metaEtag,
    });
    await this.saveCfg(cfg0);
    this.cacheManifest(workspaceId, manifest, manifestDl.etag);
    this.metaStore.put(workspaceId, meta);

    const now = new Date().toISOString();
    const withMachine: CloudManifest = {
      ...manifest,
      updatedAt: now,
      machines: this.touchMachine(manifest.machines, now),
    };
    await this.putManifest(workspaceId, withMachine, manifestDl.etag);

    await this.adoptManifestFilesFromCloud(workspaceId);
    await this.syncWorkspace(workspaceId);
    // Initial attach: materialise cloud-newer files on disk so the user lands
    // in a ready-to-edit state. Without this `syncWorkspace` only marks them
    // `cloud_newer` in the manifest and the user is forced to run Pull manually.
    await this.forcePullWorkspace(workspaceId);
    const cfgEnd = await this.loadCfg();
    await this.saveCfg(cfgEnd);
  }

  /** Добавляет в `vscodesync.json` строки для путей из облачного манифеста, которых ещё нет локально. */
  private async adoptManifestFilesFromCloud(workspaceId: string): Promise<void> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      return;
    }
    const manifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!manifest) {
      return;
    }
    const meta = await this.pullMeta(workspaceId, entry.metaEtag);
    const stamp = new Date().toISOString();

    // Which files to take over is decided by `planTrackingDiff` (pure); this
    // loop only applies the decision. `existsLocally` is resolved up front so
    // the planner stays free of I/O.
    //
    // Link Bindings: a folder rule redirects where an adopted file LIVES on
    // this machine — the planner keeps speaking canonical keys throughout,
    // placement resolves here at the disk boundary.
    const folderRules = manifest.folderBindings?.[this.deps.machineId];
    const placementOf = (posixRel: string): string =>
      localPathForCanonicalKey(folderRules, posixRel) ?? posixRel;
    // Sync scope: folders this machine did not subscribe to are not adopted —
    // otherwise the panel fills with "нет на диске" rows nobody asked for.
    const scopes = entry.syncScopes;
    const inScope = (canonicalKey: string): boolean => isInSyncScope(scopes, canonicalKey);
    const candidatePaths = manifest.files
      .filter((f) => !f.removedAt && inScope(f.path))
      .map((f) => f.path);
    const existing = new Set<string>();
    for (const posixRel of candidatePaths) {
      if (await fileExists(this.localAbs(cfg, placementOf(posixRel)))) existing.add(posixRel);
    }
    const diff = planTrackingDiff({
      workspaceId,
      // Out-of-scope rows are invisible to the planner: neither adopted nor
      // pruned — this machine simply does not carry that folder.
      manifestFiles: manifest.files.filter((f) => inScope(f.path)),
      // Link Bindings: tracked rows are known to the manifest by their
      // canonical key — localPath here would false-adopt every bound file.
      trackedPaths: cfg.files
        .filter((f) => f.workspaceId === workspaceId && inScope(manifestKeyOf(f)))
        .map((f) => manifestKeyOf(f)),
      metaHashFor: (rel: string) => meta.files[rel]?.hash,
      wireGzipFor: (rel: string) => meta.files[rel]?.wireGzip === true,
      existsLocally: (rel: string) => existing.has(rel),
    });

    let changed = false;
    for (const r of diff.rename) {
      const oldIdx = cfg.files.findIndex(
        (f) => f.workspaceId === workspaceId && manifestKeyOf(f) === r.from,
      );
      if (oldIdx < 0) continue;
      const prev = cfg.files[oldIdx];
      // A canonical rename replayed here moves only the KEY when bytes exist
      // at this machine's placement (stage 3 — no silent disk moves): the row
      // stays where it is, the UI offers "переместить у меня" as an explicit
      // action. A row with no local bytes has nothing to preserve — it follows
      // the rename to its (folder-rule-mapped) placement.
      const bytesAtPlacement = await fileExists(this.localAbs(cfg, prev.localPath));
      if (bytesAtPlacement) {
        cfg.files[oldIdx] = {
          ...prev,
          manifestPath: prev.localPath === r.to ? undefined : r.to,
          cloudPath: blobCloudPath(workspaceId, r.to, r.wireGzip),
        };
        if (prev.localPath !== r.to) {
          this.deps.onCanonicalRenameReplayed?.({
            workspaceId,
            from: r.from,
            to: r.to,
            localPlacement: prev.localPath,
          });
        }
      } else {
        const renamedPlacement = placementOf(r.to);
        cfg.files[oldIdx] = {
          ...prev,
          localPath: renamedPlacement,
          manifestPath: renamedPlacement === r.to ? undefined : r.to,
          cloudPath: blobCloudPath(workspaceId, r.to, r.wireGzip),
          localHash: r.localHash,
        };
      }
      changed = true;
    }
    for (const a of diff.adopt) {
      const placement = placementOf(a.posixRel);
      cfg.files.push({
        localPath: placement,
        workspaceId,
        cloudPath: blobCloudPath(workspaceId, a.posixRel, a.wireGzip),
        lastSync: stamp,
        localHash: a.localHash,
        syncStatus: a.syncStatus,
        ...(placement !== a.posixRel ? { manifestPath: a.posixRel } : {}),
      });
      changed = true;
    }
    if (changed) {
      await this.saveCfg(cfg);
    }
  }

  /** Single owner of `.vscode/vscodesync.json` for this workspace root. */
  private get cfgStore(): WorkspaceConfigStore {
    return getWorkspaceConfigStore(this.deps.workspaceRoot);
  }

  private async loadCfg(): Promise<WorkspaceConfig> {
    return this.cfgStore.load();
  }

  private async saveCfg(c: WorkspaceConfig): Promise<void> {
    return this.cfgStore.save(c);
  }

  private posixRel(cfg: WorkspaceConfig, fsPath: string): string {
    return absoluteToTrackedPosix(this.deps.workspaceRoot, cfg.pathMapping, this.deps.machineName, fsPath);
  }

  private localAbs(cfg: WorkspaceConfig, posixRel: string): string {
    return trackedLocalAbsolutePath(this.deps.workspaceRoot, cfg.pathMapping, this.deps.machineName, posixRel);
  }

  private async assertFileWithinSizeLimit(abs: string): Promise<void> {
    const max = this.deps.maxFileSizeBytes;
    if (max === undefined || max <= 0) {
      return;
    }
    const st = await fs.stat(abs);
    if (st.size > max) {
      throw new Error(
        `Файл слишком большой для лимита синхронизации (${String(st.size)} B > ${String(max)} B). Увеличьте vscodesync.maxFileSizeMB или установите 0.`,
      );
    }
  }

  private async patchEntry(workspaceId: string, patch: Partial<ActiveWorkspaceEntry>): Promise<void> {
    // Runs inside the store's serialised queue: load, mutate and save cannot be
    // interleaved by another workspace branch any more.
    await this.cfgStore.mutate((cfg) => {
      const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === workspaceId);
      if (ix < 0) {
        throw new Error(`active workspace not found: ${workspaceId}`);
      }
      cfg.activeWorkspaces[ix] = { ...cfg.activeWorkspaces[ix], ...patch };
    });
  }

  private findTracked(cfg: WorkspaceConfig, workspaceId: string, posixRel: string): TrackedFile | undefined {
    return cfg.files.find((f) => f.workspaceId === workspaceId && f.localPath === posixRel);
  }

  async createWorkspace(workspaceNote: string, providerType: CloudManifest["providerType"]): Promise<string> {
    this.assertMayMutate("createWorkspace");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const workspaceId = randomBytes(4).toString("hex");
    const now = new Date().toISOString();
    const manifest: CloudManifest = {
      schemaVersion: SUPPORTED_MANIFEST_SCHEMA,
      workspaceId,
      workspaceNote,
      tags: [],
      sharedIgnorePatterns: [],
      providerType,
      createdAt: now,
      updatedAt: now,
      machines: [
        {
          machineId: this.deps.machineId,
          machineName: this.deps.machineName,
          lastSeen: now,
        },
      ],
      files: [],
    };
    const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const up = await this.deps.provider.uploadFile(manifestCloudPath(workspaceId), body);
    const metaBody = Buffer.from(`${JSON.stringify(EMPTY_META_JSON, null, 2)}\n`, "utf8");
    const metaUp = await this.deps.provider.uploadFile(metaCloudPath(workspaceId), metaBody);

    const cfg = await this.loadCfg();
    cfg.activeWorkspaces.push({
      workspaceId,
      workspaceNote,
      tags: [],
      sharedIgnorePatterns: [],
      providerType,
      manifestMachines: manifestMachineCache(manifest),
      manifestEtag: up.etag,
      metaEtag: metaUp.etag,
    });
    await this.saveCfg(cfg);
    this.cacheManifest(workspaceId, manifest, up.etag);
    return workspaceId;
  }

  /** Только локально: убрать workspace и его трекинг (облако не изменяется). */
  async detachWorkspaceLocal(workspaceId: string): Promise<void> {
    this.assertMayMutate("detachWorkspaceLocal");
    await this.detachWorkspaceLocalInternal(workspaceId);
  }

  /**
   * Ungated body of {@link detachWorkspaceLocal}.
   *
   * Detach is reachable two ways: as a user command, and as the engine's own
   * reaction to a manifest that answered NOT_FOUND. The gate therefore sits on
   * the public entry point, and internal callers use this after deciding for
   * themselves — `deleteWorkspaceFromCloud` and `forcePullWorkspace` because
   * they are already past their own checkpoint, `syncWorkspace` because it asks
   * `mayMutate` first, the check-only branch having deliberately skipped the
   * checkpoint.
   */
  private async detachWorkspaceLocalInternal(workspaceId: string): Promise<void> {
    const cfg = await this.loadCfg();
    const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === workspaceId);
    if (ix < 0) {
      throw new Error("workspace не подключён к этому проекту");
    }
    cfg.activeWorkspaces.splice(ix, 1);
    cfg.files = cfg.files.filter((f) => f.workspaceId !== workspaceId);
    await this.saveCfg(cfg);
    this.evictManifestCache(workspaceId);
    this.metaStore.forget(workspaceId);
  }

  /**
   * Deletes every blob under `VSCodeSyncFiles/{workspaceId}/`, then detaches this workspace locally.
   * Ignores Suspend/Freeze — destructive op.
   */
  async deleteWorkspaceFromCloud(workspaceId: string): Promise<void> {
    this.assertMayMutate("deleteWorkspaceFromCloud");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg = await this.loadCfg();
    if (!cfg.activeWorkspaces.some((w) => w.workspaceId === workspaceId)) {
      throw new Error("workspace не подключён к этому проекту");
    }
    await this.deleteCloudFilesOnly(workspaceId);
    await this.detachWorkspaceLocalInternal(workspaceId);
  }

  /**
   * Deletes only cloud blobs under `VSCodeSyncFiles/{workspaceId}/`.
   * Does NOT touch local config — caller is responsible for local detach/restore.
   *
   * Explicitly deletes the manifest and meta files by known path because some
   * providers (OneDrive, GDrive) omit dot-prefixed files from listFolder results,
   * so deleteCloudFolderRecursive alone would miss .vscodesync-workspace.json.
   */
  async deleteCloudFilesOnly(workspaceId: string): Promise<void> {
    this.assertMayMutate("deleteCloudFilesOnly");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await deleteCloudFolderRecursive(this.deps.provider, workspaceRootPath(workspaceId));
    // Explicitly delete known dot-prefixed files that listFolder may skip
    for (const knownPath of [manifestCloudPath(workspaceId), metaCloudPath(workspaceId)]) {
      try {
        await this.deps.provider.deleteFile(knownPath);
      } catch (e) {
        if (!(e instanceof ProviderError && e.code === "NOT_FOUND")) {
          throw e;
        }
      }
    }
  }

  /**
   * Re-adds a previously detached workspace entry and its tracked files back to local config.
   * Used for rollback when cloud deletion fails after early local detach.
   */
  async restoreWorkspaceLocal(entry: ActiveWorkspaceEntry, files: TrackedFile[]): Promise<void> {
    this.assertMayMutate("restoreWorkspaceLocal");
    const cfg = await this.loadCfg();
    if (!cfg.activeWorkspaces.some((w) => w.workspaceId === entry.workspaceId)) {
      cfg.activeWorkspaces.push(entry);
    }
    for (const f of files) {
      if (!cfg.files.some((existing) => existing.localPath === f.localPath && existing.workspaceId === f.workspaceId)) {
        cfg.files.push(f);
      }
    }
    await this.saveCfg(cfg);
  }

  /**
   * Re-uploads a workspace that was previously auto-detached after remote deletion.
   * Restores local config, rebuilds the cloud manifest from tracked file state, then syncs.
   * Called when the user chooses "Re-upload to cloud" after the deletion prompt.
   */
  async repushWorkspaceToCloud(
    workspaceId: string,
    savedEntry: ActiveWorkspaceEntry,
    savedFiles: TrackedFile[],
  ): Promise<void> {
    this.assertMayMutate("repushWorkspaceToCloud");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.restoreWorkspaceLocal(savedEntry, savedFiles);
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error(`workspace ${workspaceId} not found after local restore`);
    }
    await this.rebuildManifestFromLocalState(workspaceId, cfg, entry);
    await this.syncWorkspace(workspaceId);
  }

  /** Depth-first delete for Graph (direct children); mock returns flat descendants — still safe. */
  /**
   * Копирует все активные треки из источника в цель (облачные blobs + merge манифеста/`_meta`), обновляет `vscodesync.json`.
   * Пересечение активных путей в двух workspace → ошибка до любых изменений.
   *
   * @param deleteSourceWorkspace true — удалить папку `VSCodeSyncFiles/{sourceId}` на облаке; false — опустошить источник (удалены перенесённые blobs, manifest.files=[], пустой _meta).
   */
  async mergeWorkspaces(
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    options: { deleteSourceWorkspace?: boolean } = {},
  ): Promise<void> {
    this.assertMayMutate("mergeWorkspaces");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const deleteSourceWorkspace = options.deleteSourceWorkspace ?? false;
    if (sourceWorkspaceId === targetWorkspaceId) {
      throw new Error("Источник и цель merge должны различаться.");
    }
    await this.ensureWorkspaceMayUploadFiles(targetWorkspaceId);
    await this.ensureWorkspaceNotSuspendedNorFrozen(sourceWorkspaceId);
    await this.ensureWorkspaceNotSuspendedNorFrozen(targetWorkspaceId);

    let cfgInit = await this.loadCfg();
    const entSrc = cfgInit.activeWorkspaces.find((w) => w.workspaceId === sourceWorkspaceId);
    const entTgt = cfgInit.activeWorkspaces.find((w) => w.workspaceId === targetWorkspaceId);
    if (!entSrc || !entTgt) {
      throw new Error("Оба workspace должны быть подключены в этом проекте.");
    }

    this.evictManifestCache(sourceWorkspaceId);
    this.evictManifestCache(targetWorkspaceId);
    this.metaStore.forget(sourceWorkspaceId);
    this.metaStore.forget(targetWorkspaceId);

    const srcManifestFull = await this.downloadManifest(sourceWorkspaceId, entSrc.manifestEtag);
    const tgtManifestFull = await this.downloadManifest(targetWorkspaceId, entTgt.manifestEtag);
    if (!srcManifestFull || !tgtManifestFull) {
      throw new Error("Не удалось прочитать манифест с облака.");
    }

    const srcPaths = new Set(srcManifestFull.files.filter((f) => !f.removedAt).map((f) => f.path));
    const tgtPaths = new Set(tgtManifestFull.files.filter((f) => !f.removedAt).map((f) => f.path));
    const conflict = [...srcPaths].filter((p) => tgtPaths.has(p));
    if (conflict.length > 0) {
      const hint = conflict
        .slice(0, 10)
        .map((p) => `«${p}»`)
        .join(", ");
      throw new Error(
        `Merge невозможен: есть одинаковые активные пути (${String(conflict.length)} шт.). Примеры: ${hint}`,
      );
    }
    if (srcPaths.size === 0) {
      throw new Error("В источнике нет активных файлов — нечего переносить.");
    }

    const snapHint = `auto-pre-merge-${new Date().toISOString().slice(0, 10)}`;
    const snapCrypto = this.snapshotCrypto();
    await createWorkspaceSnapshot(
      this.deps.provider,
      this.deps.workspaceRoot,
      sourceWorkspaceId,
      snapHint,
      this.deps.machineName,
      snapCrypto,
    );
    await createWorkspaceSnapshot(
      this.deps.provider,
      this.deps.workspaceRoot,
      targetWorkspaceId,
      snapHint,
      this.deps.machineName,
      snapCrypto,
    );

    // Both sides of the copy must respect the wire encoding recorded in the
    // source `_meta`: `trackedFileCloudPath` always omits the `.gz` suffix, so
    // merging a workspace with `compressUploads` on silently skipped every
    // compressed blob and left the target pointing at objects that do not exist.
    const srcMetaForCopy = await this.pullMeta(sourceWorkspaceId, entSrc.metaEtag);
    const sortedPaths = [...srcPaths].sort((a, b) => a.localeCompare(b));
    for (const posixRel of sortedPaths) {
      const wireGzip = srcMetaForCopy.files[posixRel]?.wireGzip === true;
      const srcCloud = blobCloudPath(sourceWorkspaceId, posixRel, wireGzip);
      const dstCloud = blobCloudPath(targetWorkspaceId, posixRel, wireGzip);
      await copyCloudFileBetweenProviders(this.deps.provider, this.deps.provider, srcCloud, dstCloud);
    }

    const tgtMetaFresh = await this.pullMeta(targetWorkspaceId, entTgt.metaEtag);
    const srcMetaFresh = await this.pullMeta(sourceWorkspaceId, entSrc.metaEtag);
    const mergedMeta = mergeMetaEntries(tgtMetaFresh, srcMetaFresh);

    const now = new Date().toISOString();
    const mergedFiles = mergeManifestFiles(tgtManifestFull.files, srcManifestFull.files);
    const mergedManifest: CloudManifest = {
      ...tgtManifestFull,
      files: mergedFiles,
      tags: [...new Set([...tgtManifestFull.tags, ...srcManifestFull.tags])],
      sharedIgnorePatterns: [
        ...new Set([
          ...sharedIgnorePatternsOrEmpty(tgtManifestFull),
          ...sharedIgnorePatternsOrEmpty(srcManifestFull),
        ]),
      ],
      gitBranch: tgtManifestFull.gitBranch ?? srcManifestFull.gitBranch,
      machines: this.touchMachine(mergeMachinesPreferNewer(tgtManifestFull.machines, srcManifestFull.machines), now),
      workspaceNote: tgtManifestFull.workspaceNote,
      updatedAt: now,
    };

    cfgInit = await this.loadCfg();
    const entTgt2 = cfgInit.activeWorkspaces.find((w) => w.workspaceId === targetWorkspaceId);
    if (!entTgt2) {
      throw new Error("Целевой workspace пропал из конфига во время merge.");
    }
    await this.putManifest(targetWorkspaceId, mergedManifest, entTgt2.manifestEtag);

    cfgInit = await this.loadCfg();
    const entTgt3 = cfgInit.activeWorkspaces.find((w) => w.workspaceId === targetWorkspaceId);
    if (!entTgt3) {
      throw new Error("Целевой workspace пропал из конфига после putManifest.");
    }
    await this.pushMetaJson(targetWorkspaceId, mergedMeta, entTgt3.metaEtag, "push");

    if (!deleteSourceWorkspace) {
      await this.evacuateMergedSourceWorkspace(sourceWorkspaceId, srcManifestFull);
    }

    await this.mergeLocalTrackedAfterWorkspaceMerge(sourceWorkspaceId, targetWorkspaceId);

    if (deleteSourceWorkspace) {
      await deleteCloudFolderRecursive(this.deps.provider, workspaceRootPath(sourceWorkspaceId));
    }

    this.evictManifestCache(sourceWorkspaceId);
    this.metaStore.forget(sourceWorkspaceId);

    cfgInit = await this.loadCfg();
    const tgtEntryPost = cfgInit.activeWorkspaces.find((w) => w.workspaceId === targetWorkspaceId);
    this.evictManifestCache(targetWorkspaceId);
    await this.downloadManifest(targetWorkspaceId, tgtEntryPost?.manifestEtag);
  }

  /** Удалить перенесённые blobs, опустошить manifest и `_meta`, пока строка источника ещё в конфиге. */
  private async evacuateMergedSourceWorkspace(sourceWorkspaceId: string, priorManifest: CloudManifest): Promise<void> {
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.ensureNotFrozenForCloudWrites(sourceWorkspaceId);
    const cfg = await this.loadCfg();
    const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === sourceWorkspaceId);
    if (!ent) {
      throw new Error("источник merge не найден в конфиге (evacuate)");
    }
    const now = new Date().toISOString();
    // NOT_FOUND is swallowed below, so a path missing the `.gz` suffix looked
    // like a successful delete while the real blob stayed in the cloud forever
    // as garbage — and the manifest was emptied regardless.
    const srcMetaForEvacuate = await this.pullMeta(sourceWorkspaceId, ent.metaEtag);
    for (const mf of priorManifest.files.filter((f) => !f.removedAt)) {
      const wireGzip = srcMetaForEvacuate.files[mf.path]?.wireGzip === true;
      try {
        await this.deps.provider.deleteFile(blobCloudPath(sourceWorkspaceId, mf.path, wireGzip));
      } catch (e) {
        if (!(e instanceof ProviderError && e.code === "NOT_FOUND")) {
          throw e;
        }
      }
    }
    const emptied: CloudManifest = {
      ...priorManifest,
      files: [],
      updatedAt: now,
      machines: this.touchMachine(priorManifest.machines, now),
    };
    await this.putManifest(sourceWorkspaceId, emptied, ent.manifestEtag);
    const cfgAfterManifest = await this.loadCfg();
    const entAfter = cfgAfterManifest.activeWorkspaces.find((w) => w.workspaceId === sourceWorkspaceId);
    if (!entAfter) {
      throw new Error("источник пропал после putManifest (evacuate)");
    }
    await this.pushMetaJson(sourceWorkspaceId, EMPTY_META_JSON, entAfter.metaEtag, "push");
  }

  /** Перевести треки источника на цель; transform — `planWorkspaceMergeCfg` (pure). */
  private async mergeLocalTrackedAfterWorkspaceMerge(sourceId: string, targetId: string): Promise<void> {
    const cfg = await this.loadCfg();
    await this.saveCfg(applyWorkspaceMergeToCfg(cfg, sourceId, targetId));
  }

  /** Обновить название workspace в облачном манифесте и в `vscodesync.json`. */
  async renameWorkspaceNote(workspaceId: string, newNote: string): Promise<void> {
    this.assertMayMutate("renameWorkspaceNote");
    const note = newNote.trim();
    if (!note) {
      throw new Error("Название не может быть пустым");
    }
    await this.setManifestField(workspaceId, { workspaceNote: note }, { workspaceNote: note });
  }

  /** Поля облачного манифеста для подсказок в UI (читает манифест с облака). */
  async getWorkspaceManifestFields(
    workspaceId: string,
  ): Promise<{ workspaceNote: string; gitBranch?: string; tags: string[] } | undefined> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      return undefined;
    }
    const remote = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remote) {
      return undefined;
    }
    return {
      workspaceNote: remote.workspaceNote,
      gitBranch: remote.gitBranch,
      tags: remote.tags,
    };
  }

  async setWorkspaceGitBranch(workspaceId: string, gitBranchRaw: string): Promise<void> {
    this.assertMayMutate("setWorkspaceGitBranch");
    const branch = gitBranchRaw.trim();
    await this.setManifestField(workspaceId, { gitBranch: branch === "" ? undefined : branch }, {});
  }

  /**
   * Статус текущей машины в манифесте (`pending` / `blocked` — не автоактивировать по git-ветке).
   */
  async getSelfMachineStatusInManifest(
    workspaceId: string,
  ): Promise<"active" | "pending" | "blocked" | undefined> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      return undefined;
    }
    const m = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!m) {
      return undefined;
    }
    const me = m.machines.find((x) => x.machineId === this.deps.machineId);
    if (!me) {
      return undefined;
    }
    return me.status ?? "active";
  }

  /**
   * Выставить `machines[].status` для другой машины (одобрение / блокировка). Нельзя вызывать, если эта машина `blocked`.
   */
  async setMachineManifestStatus(
    workspaceId: string,
    targetMachineId: string,
    next: "active" | "blocked",
  ): Promise<void> {
    this.assertMayMutate("setMachineManifestStatus");
    await this.ensureNotFrozenForCloudWrites(workspaceId);
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const selfSt = await this.getSelfMachineStatusInManifest(workspaceId);
    if (selfSt === "blocked") {
      throw new Error("Машина заблокирована в манифесте — нельзя менять статус других машин.");
    }
    if (selfSt === "pending") {
      throw new Error(
        "Эта машина ещё не одобрена в манифесте — нельзя менять статус других машин.",
      );
    }
    const remote = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remote) {
      throw new Error("manifest missing on cloud");
    }
    if (!remote.machines.some((x) => x.machineId === targetMachineId)) {
      throw new Error("machine not found in manifest");
    }
    const now = new Date().toISOString();
    const machines = remote.machines.map((row) =>
      row.machineId === targetMachineId ? { ...row, status: next } : row,
    );
    const updated: CloudManifest = {
      ...remote,
      updatedAt: now,
      machines,
    };
    await this.putManifest(workspaceId, updated, entry.manifestEtag);
  }

  /** Все строки `machines` из облачного манифеста (для UI / machine approval). */
  async getWorkspaceManifestMachines(workspaceId: string): Promise<MachineEntry[]> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      return [];
    }
    const m = await this.downloadManifest(workspaceId, entry.manifestEtag);
    return m?.machines ?? [];
  }

  /**
   * Publish one manifest field and mirror it into the local entry cache. The
   * two callers below were byte-for-byte the same flow apart from the field.
   */
  private async setManifestField(
    workspaceId: string,
    fields: Partial<CloudManifest>,
    entryPatch: Parameters<SyncEngine["patchEntry"]>[1],
  ): Promise<void> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const remote = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remote) {
      throw new Error("manifest missing on cloud");
    }
    const now = new Date().toISOString();
    await this.putManifest(
      workspaceId,
      { ...remote, ...fields, updatedAt: now, machines: this.touchMachine(remote.machines, now) },
      entry.manifestEtag,
    );
    await this.patchEntry(workspaceId, entryPatch);
  }

  async setWorkspaceTags(workspaceId: string, tags: string[]): Promise<void> {
    this.assertMayMutate("setWorkspaceTags");
    const normalized = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))];
    await this.setManifestField(workspaceId, { tags: normalized }, { tags: normalized });
  }

  async setWorkspaceSharedIgnorePatterns(workspaceId: string, patterns: string[]): Promise<void> {
    this.assertMayMutate("setWorkspaceSharedIgnorePatterns");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const normalized = normalizeIgnorePatternStrings(patterns);
    await this.setManifestField(
      workspaceId,
      { sharedIgnorePatterns: normalized },
      { sharedIgnorePatterns: normalized },
    );
  }

  /** Cloud manifest `sharedIgnorePatterns` (fresh download / cache refresh). */
  async readSharedIgnorePatterns(workspaceId: string): Promise<string[]> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const m = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!m) {
      return [];
    }
    return sharedIgnorePatternsOrEmpty(m);
  }

  /** Доступен ли облачный манифест для активного workspace. */
  async healthCheckWorkspace(workspaceId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const cfg = await this.loadCfg();
      const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) {
        return { ok: false, message: "workspace не в списке активных" };
      }
      const m = await this.downloadManifest(workspaceId, entry.manifestEtag);
      if (!m) {
        return { ok: false, message: "манифест недоступен" };
      }
      // Link Bindings: a bind racing a canonical rename can leave one linkId
      // on two live rows — surfaced here, repaired via repairDuplicateLinkIds.
      const dupes = findDuplicateLinkIds(m.files);
      if (dupes.length > 0) {
        return {
          ok: false,
          message: `дубликат идентичности (linkId) у: ${dupes.map((d) => d.paths.join(" ↔ ")).join("; ")}`,
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Manifest paths with abandoned soft lock (`editingBy` / `editingSince` older than threshold).
   * Read-only; uses same manifest fetch as Health Check.
   */
  async listStaleManifestEditingLocks(workspaceId: string): Promise<
    { path: string; editingBy: string; editingSince: string; ageHours: number }[]
  > {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      return [];
    }
    const m = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!m) {
      return [];
    }
    // One definition of "stale", shared with the clearing path below.
    return findStaleLocks(m, this.resolveSoftLockStaleMs(), Date.now()).map((r) => ({
      path: r.posixRel,
      editingBy: r.machineId,
      editingSince: r.editingSince,
      ageHours: r.ageMs / 3600_000,
    }));
  }

  /**
   * Clear soft locks on manifest files when `editingSince` is older than `STALE_MANIFEST_EDITING_LOCK_MS`.
   * @returns Number of files updated.
   */
  async clearStaleManifestEditingLocks(workspaceId: string): Promise<number> {
    this.assertMayMutate("clearStaleManifestEditingLocks");
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const m = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!m) {
      throw new Error("manifest missing");
    }
    const nowIso = new Date().toISOString();
    const stale = new Set(
      findStaleLocks(m, this.resolveSoftLockStaleMs(), Date.now()).map((r) => r.posixRel),
    );
    const cleared = stale.size;
    if (cleared === 0) {
      return 0;
    }
    // Clearing someone else's abandoned lock *is* an edit to the row, so the
    // version bumps here — unlike taking or dropping your own lock.
    const files: ManifestFile[] = m.files.map((f) => {
      if (!stale.has(f.path)) {
        return f;
      }
      const rest = { ...f };
      delete rest.editingBy;
      delete rest.editingSince;
      return { ...rest, version: f.version + 1 };
    });
    const updated: CloudManifest = {
      ...m,
      files,
      updatedAt: nowIso,
      machines: this.touchMachine(m.machines, nowIso),
    };
    await this.putManifest(workspaceId, updated, entry.manifestEtag);
    return cleared;
  }

  /**
   * Set soft lock on a tracked file: updates manifest with `editingBy = machineId, editingSince = now`.
   * Should be called when user opens a tracked file in the editor.
   * Non-fatal: if manifest write fails, lock is not set (graceful degradation).
   */
  async setSoftLock(workspaceId: string, posixRel: string): Promise<void> {
    this.assertMayMutate("setSoftLock");
    verboseLog("softlock", `set START ws=${workspaceId} file=${posixRel}`);
    if (isSecondaryWorkspaceInstanceReadOnly()) {
      return;
    }
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      return;
    }
    const m = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!m) {
      return;
    }
    // `downloadManifest` just refreshed the stored etag; re-read it instead of
    // sending the pre-download one. The stale etag put every lock write on the
    // 412-merge path, where the version tie-break belongs to the remote row —
    // which was masked while `setSoftLock` inflated `version` on each call.
    const freshEtag = await this.currentManifestEtag(workspaceId, entry.manifestEtag);
    const now = new Date().toISOString();
    // Link Bindings: the lock lives on the canonical manifest row.
    const lockTracked = this.findTracked(cfg, workspaceId, posixRel);
    const files = applyLockChange(m.files, lockTracked ? manifestKeyOf(lockTracked) : posixRel, {
      machineId: this.deps.machineId,
      sinceIso: now,
    });
    if (files === null) {
      return;
    }
    const updated: CloudManifest = {
      ...m,
      updatedAt: now,
      machines: this.touchMachine(m.machines, now),
      files,
    };
    try {
      await this.putManifest(workspaceId, updated, freshEtag);
      verboseLog("softlock", `set DONE ${posixRel}`);
    } catch (e: unknown) {
      warnLog(
        "softlock",
        `set FAILED (non-fatal) ${posixRel}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Clear soft lock on a tracked file: removes `editingBy` / `editingSince` from manifest.
   * Should be called when user closes the file or finishes Push.
   */
  async clearSoftLock(workspaceId: string, posixRel: string): Promise<void> {
    this.assertMayMutate("clearSoftLock");
    verboseLog("softlock", `clear START ws=${workspaceId} file=${posixRel}`);
    if (isSecondaryWorkspaceInstanceReadOnly()) {
      return;
    }
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      return;
    }
    const m = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!m) {
      return;
    }
    const freshEtag = await this.currentManifestEtag(workspaceId, entry.manifestEtag);
    // Link Bindings: the lock lives on the canonical manifest row.
    const lockTracked = this.findTracked(cfg, workspaceId, posixRel);
    const lockKey = lockTracked ? manifestKeyOf(lockTracked) : posixRel;
    const existing = m.files.find((f) => f.path === lockKey && !f.removedAt);
    if (!existing?.editingBy || existing.editingBy !== this.deps.machineId) {
      return; // Only clear own lock
    }
    const now = new Date().toISOString();
    const files = applyLockChange(m.files, lockKey, null);
    if (files === null) {
      return;
    }
    const updated: CloudManifest = {
      ...m,
      updatedAt: now,
      machines: this.touchMachine(m.machines, now),
      files,
    };
    try {
      await this.putManifest(workspaceId, updated, freshEtag);
      verboseLog("softlock", `clear DONE ${posixRel}`);
    } catch (e: unknown) {
      warnLog(
        "softlock",
        `clear FAILED (non-fatal) ${posixRel}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Подтянуть с облака свежие ETag манифеста и `_meta`, обновить `workspaceNote` в локальном кэше.
   * Не выполняет push/pull файлов.
   */
  async repairLocalStateFromCloud(workspaceId?: string): Promise<void> {
    this.assertMayMutate("repairLocalStateFromCloud");
    const cfg = await this.loadCfg();
    const list = workspaceId
      ? cfg.activeWorkspaces.filter((w) => w.workspaceId === workspaceId)
      : [...cfg.activeWorkspaces];
    if (list.length === 0) {
      throw new Error("нет активных workspace");
    }
    for (const entry of list) {
      const id = entry.workspaceId;
      const manDl = await this.deps.provider.downloadFile(manifestCloudPath(id));
      const rawManifest: unknown = JSON.parse(manDl.body.toString("utf8"));
      if (!rawManifest || typeof rawManifest !== "object") {
        throw new Error(`workspace ${id}: манифест не является объектом`);
      }
      const probe = rawManifest as { schemaVersion?: unknown; workspaceId?: unknown };
      if (probe.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
        throw new Error(`workspace ${id}: неподдерживаемая schemaVersion`);
      }
      if (probe.workspaceId !== id) {
        throw new Error(`workspace ${id}: workspaceId в манифесте не совпадает`);
      }
      const manifest = rawManifest as CloudManifest;
      this.cacheManifest(id, manifest, manDl.etag);
      let meta: MetaJson;
      let metaEtag: string | undefined;
      try {
        const metaDl = await this.deps.provider.downloadFile(metaCloudPath(id));
        meta = JSON.parse(metaDl.body.toString("utf8")) as MetaJson;
        metaEtag = metaDl.etag;
      } catch (e) {
        if (e instanceof ProviderError && e.code === "NOT_FOUND") {
          meta = { files: {} };
          metaEtag = undefined;
        } else {
          throw e;
        }
      }
      this.metaStore.put(id, meta);
      const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === id);
      if (ix < 0) {
        continue;
      }
      cfg.activeWorkspaces[ix] = {
        ...cfg.activeWorkspaces[ix],
        manifestEtag: manDl.etag,
        metaEtag,
        workspaceNote: manifest.workspaceNote,
        tags: manifest.tags,
        gitBranch: manifest.gitBranch,
        sharedIgnorePatterns: sharedIgnorePatternsOrEmpty(manifest),
        providerType: manifest.providerType,
        manifestMachines: manifestMachineCache(manifest),
      };
    }
    await this.saveCfg(cfg);
  }

  /**
   * `opts.canonicalRoot` (Link Bindings): send `localDirRel/**` to the cloud
   * as `canonicalRoot/**` — the sender decides how much of its own leading
   * path is local dressing (home `src/SEMD272/jscore` → cloud `jscore`). The
   * dropped part is recorded as this machine's folder rule, so future files on
   * both sides follow the same mapping.
   */
  async addFiles(
    workspaceId: string,
    absolutePaths: string[],
    opts?: { linkName?: string; canonicalRoot?: { localDirRel: string; canonicalRoot: string } },
  ): Promise<void> {
    this.assertMayMutate("addFiles");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.ensureWorkspaceMayUploadFiles(workspaceId);
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const remoteManifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remoteManifest) {
      throw new Error("manifest missing on cloud");
    }
    const now = new Date().toISOString();
    const localCopy: CloudManifest = {
      ...remoteManifest,
      updatedAt: now,
      machines: this.touchMachine(remoteManifest.machines, now),
      files: [...remoteManifest.files],
    };
    const meta = await this.pullMeta(workspaceId, entry.metaEtag);
    // Link Bindings: a fresh file under a folder rule's local prefix is keyed
    // under the canonical prefix (work `promed/**` ↔ home `php/**`). An
    // explicit `canonicalRoot` for this batch wins over the stored rules — it
    // IS the user choosing the mapping right now.
    const chosenRoot = opts?.canonicalRoot;
    const addFolderRules = chosenRoot
      ? {
          [normalizeDirPrefix(chosenRoot.canonicalRoot)]: {
            path: normalizeDirPrefix(chosenRoot.localDirRel),
            boundAt: now,
          },
        }
      : remoteManifest.folderBindings?.[this.deps.machineId];
    for (const abs of absolutePaths) {
      await this.assertFileWithinSizeLimit(abs);
      const posixRel = this.posixRel(cfg, abs);
      // Re-adding an already-bound file must stay on its canonical key —
      // keying by the local placement would fork the manifest row, `_meta`
      // row and blob.
      const prior = this.findTracked(cfg, workspaceId, posixRel);
      const key = prior
        ? manifestKeyOf(prior)
        : canonicalKeyForLocalPath(addFolderRules, posixRel) ?? posixRel;
      const markers = await this.fileHasSyncMarkers(abs);
      const existing = localCopy.files.find((f) => f.path === key && !f.removedAt);
      // Fresh rows get a random stable identity and a human label right away;
      // an existing legacy row keeps `undefined` here until the write-path
      // backfill fills it (tracking cache catches up later).
      const rowLinkId = existing ? existing.linkId : newLinkId();
      if (!existing) {
        localCopy.files.push({
          path: key,
          addedAt: now,
          version: this.nextManifestVersion(localCopy.files),
          hasSyncignoreMarkers: markers,
          linkId: rowLinkId,
          linkName: (absolutePaths.length === 1 ? opts?.linkName : undefined) ?? defaultLinkName(key),
        });
      }
      // Same pipeline as `pushFile`. This used to call `pushBlobRaw`, which
      // uploaded the file byte-for-byte: no compression, and — with encryption
      // switched on — no encryption either, to a path computed without the
      // `.gz` suffix. The blob was then downloaded again in full purely to read
      // its etag, which `uploadFile` already returns.
      this.assertEncryptionReady();
      const plaintext = await fs.readFile(abs);
      const encoded = planUploadEncoding({
        workspaceId,
        posixRel: key,
        plaintext,
        encrypt: this.deps.encrypt,
        decrypt: this.deps.decrypt,
        compressUploads: this.deps.compressUploads,
      });
      const cloudPath = encoded.cloudPath;
      const uploaded = await this.deps.provider.uploadFile(cloudPath, encoded.body, { signal: this.abortSignal });
      this.emitTransfer({ direction: "upload", bytes: encoded.body.length });
      const hash = hashCanonicalBuffer(plaintext, key, this.hashCfg(key));
      const prev = meta.files[key];
      const prevVersion = prev === undefined ? 0 : prev.version;
      const row: MetaEntry = {
        hash,
        etag: uploaded.etag ?? "",
        version: prevVersion + 1,
        machineId: this.deps.machineId,
        updatedAt: new Date().toISOString(),
      };
      if (encoded.wireGzip) {
        row.wireGzip = true;
      }
      meta.files[key] = row;
      this.metaStore.put(workspaceId, meta);
      const tracked: TrackedFile = {
        localPath: posixRel,
        workspaceId,
        cloudPath,
        lastSync: now,
        localHash: hash,
        syncStatus: "ok",
        ...(key !== posixRel ? { manifestPath: key } : {}),
        ...(rowLinkId !== undefined ? { linkId: rowLinkId } : {}),
      };
      const ix = cfg.files.findIndex((f) => f.workspaceId === workspaceId && f.localPath === posixRel);
      if (ix >= 0) {
        cfg.files[ix] = tracked;
      } else {
        cfg.files.push(tracked);
      }
      this.fireActivity({
        kind: "add",
        workspaceId,
        workspaceNote: entry.workspaceNote,
        relPath: posixRel,
        machineName: this.deps.machineName,
        provider: this.deps.provider.type,
      });
    }
    let diskCfg = await this.loadCfg();
    const entDisk = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entDisk) {
      throw new Error("workspace entry lost");
    }
    await this.pushMetaJson(workspaceId, meta, entDisk.metaEtag, "push");
    diskCfg = await this.loadCfg();
    const entAfterMeta = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entAfterMeta) {
      throw new Error("workspace entry lost");
    }
    const merged = mergeCloudManifests(localCopy, remoteManifest);
    // Record the chosen mapping as this machine's folder rule, so files added
    // to the same folder later keep the same canonical prefix without asking.
    const ruleCanon = chosenRoot ? normalizeDirPrefix(chosenRoot.canonicalRoot) : "";
    const ruleLocal = chosenRoot ? normalizeDirPrefix(chosenRoot.localDirRel) : "";
    const withRule =
      chosenRoot && ruleCanon !== ruleLocal
        ? {
            ...merged,
            folderBindings: {
              ...merged.folderBindings,
              [this.deps.machineId]: {
                ...merged.folderBindings?.[this.deps.machineId],
                [ruleCanon]: { path: ruleLocal, boundAt: now },
              },
            },
          }
        : merged;
    await this.putManifest(workspaceId, withRule, entAfterMeta.manifestEtag);
    const finalCfg = await this.loadCfg();
    finalCfg.files = cfg.files;
    await this.saveCfg(finalCfg);
  }

  /**
   * Link Bindings (docs/v2/linkBindings.md): bind an existing local file to a
   * live manifest row. Pure metadata — no content moves. All decisions live in
   * `planBindLocalFile`; this method is the I/O shell around it.
   */
  async bindLocalFile(
    workspaceId: string,
    manifestKey: string,
    localAbsPath: string,
    opts?: { replaceExisting?: boolean },
  ): Promise<{ localPosixRel: string; contentMatches: boolean }> {
    this.assertMayMutate("bindLocalFile");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const localPosixRel = this.posixRel(cfg, localAbsPath);
    const remoteManifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remoteManifest) {
      throw new Error("manifest missing on cloud");
    }
    const meta = await this.pullMeta(workspaceId, entry.metaEtag);
    const now = new Date().toISOString();
    const plan = planBindLocalFile({
      workspaceId,
      manifestKey,
      localPosixRel,
      machineId: this.deps.machineId,
      trackedFiles: cfg.files,
      manifestFiles: remoteManifest.files,
      metaEntry: meta.files[manifestKey],
      // "" (absent bytes) → planner records missing_local; pull fills it in.
      localHash: await this.hashTrackedFile(localAbsPath, manifestKey).catch(() => ""),
      nextVersion: this.nextManifestVersion(remoteManifest.files),
      nowIso: now,
      replaceExisting: opts?.replaceExisting === true,
    });
    if (!plan.ok) {
      throw new BindRejectedError(plan.reason, plan.detail);
    }
    const localCopy: CloudManifest = {
      ...remoteManifest,
      updatedAt: now,
      machines: this.touchMachine(remoteManifest.machines, now),
      files: remoteManifest.files.map((f) => (f.path === manifestKey ? plan.updatedRow : f)),
    };
    await this.putManifest(workspaceId, localCopy, entry.manifestEtag);
    const freshCfg = await this.loadCfg();
    freshCfg.files = freshCfg.files.filter(
      (f) => !(f.workspaceId === workspaceId && (manifestKeyOf(f) === manifestKey || f.localPath === localPosixRel)),
    );
    freshCfg.files.push(plan.tracked);
    await this.saveCfg(freshCfg);
    this.fireActivity({
      kind: "bind",
      workspaceId,
      workspaceNote: entry.workspaceNote,
      relPath: localPosixRel,
      machineName: this.deps.machineName,
      provider: this.deps.provider.type,
    });
    return { localPosixRel, contentMatches: plan.contentMatches };
  }

  /**
   * Link Bindings: which canonical folders this machine carries. Local and
   * per-machine — nothing is written to the cloud, and dropping a folder from
   * the list untracks its rows here without touching anyone else's copy.
   */
  async setWorkspaceSyncScopes(workspaceId: string, scopes: readonly string[]): Promise<void> {
    this.assertMayMutate("setWorkspaceSyncScopes");
    const cfg = await this.loadCfg();
    const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === workspaceId);
    if (ix < 0) {
      throw new Error("workspace not active");
    }
    const normalized = normalizeSyncScopes(scopes);
    cfg.activeWorkspaces[ix] = { ...cfg.activeWorkspaces[ix], syncScopes: normalized };
    // Rows outside the new scope stop being tracked here. Bytes on disk are
    // untouched — this is a subscription change, not a deletion.
    cfg.files = cfg.files.filter(
      (f) => f.workspaceId !== workspaceId || isInSyncScope(normalized, manifestKeyOf(f)),
    );
    await this.saveCfg(cfg);
    await this.adoptManifestFilesFromCloud(workspaceId);
  }

  /** Link Bindings: rename the human label of a cloud entry (not a key — collisions allowed). */
  async renameLinkName(workspaceId: string, manifestKey: string, linkName: string): Promise<void> {
    this.assertMayMutate("renameLinkName");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const remoteManifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remoteManifest) {
      throw new Error("manifest missing on cloud");
    }
    const now = new Date().toISOString();
    await this.putManifest(
      workspaceId,
      manifestWithLinkName({
        manifest: remoteManifest,
        manifestKey,
        linkName,
        nowIso: now,
        nextVersion: this.nextManifestVersion(remoteManifest.files),
        touchMachines: (machines, nowIso) => this.touchMachine(machines, nowIso),
      }),
      entry.manifestEtag,
    );
  }

  /**
   * Link Bindings: bind a whole canonical folder to a local folder with the
   * same inner structure (work `promed/**` ↔ home `php/**`). Writes this
   * machine's folder rule into the manifest, re-places already-tracked rows
   * whose file actually lives under the local prefix, then lets the regular
   * adoption pass register the rest. Metadata only — no content moves.
   */
  async bindLocalFolder(
    workspaceId: string,
    canonicalDirPrefix: string,
    localAbsDir: string,
    opts?: { localDirRel?: string },
  ): Promise<{ localDirRel: string; reboundTracked: number }> {
    this.assertMayMutate("bindLocalFolder");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const canonPrefix = normalizeDirPrefix(canonicalDirPrefix);
    // A folder that does not exist yet is a legal target: the rule decides
    // where FUTURE files land, and the first pull creates the directory. So
    // the caller may pass the relative path directly instead of an existing
    // absolute one.
    const localDirRel =
      opts?.localDirRel !== undefined
        ? normalizeDirPrefix(opts.localDirRel)
        : normalizeDirPrefix(this.posixRel(cfg, localAbsDir));
    if (canonPrefix === "" || localDirRel === "") {
      throw new Error("empty folder prefix");
    }
    const remoteManifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remoteManifest) {
      throw new Error("manifest missing on cloud");
    }
    const now = new Date().toISOString();
    await this.putManifest(
      workspaceId,
      manifestWithFolderRule({
        manifest: remoteManifest,
        machineId: this.deps.machineId,
        canonPrefix,
        localDirRel,
        nowIso: now,
        touchMachines: (machines, nowIso) => this.touchMachine(machines, nowIso),
      }),
      entry.manifestEtag,
    );
    const meta = await this.pullMeta(workspaceId, entry.metaEtag);
    const freshCfg = await this.loadCfg();
    const rebound = await replaceStrandedRows({
      cfg: freshCfg,
      workspaceId,
      canonPrefix,
      localDirRel,
      meta,
      localAbs: (rel) => this.localAbs(freshCfg, rel),
      fileExists,
      hashTracked: (abs, key) => this.hashTrackedFile(abs, key),
    });
    await this.saveCfg(freshCfg);
    await this.adoptManifestFilesFromCloud(workspaceId);
    this.fireActivity({
      kind: "bind",
      workspaceId,
      workspaceNote: entry.workspaceNote,
      relPath: `${localDirRel}/ ⇄ ${canonPrefix}/`,
      machineName: this.deps.machineName,
      provider: this.deps.provider.type,
    });
    return { localDirRel, reboundTracked: rebound };
  }

  /** Удалить файлы из трекинга: blob в облаке, строка в `_meta`, tombstone в манифесте, запись в локальном кэше. */
  async removeTrackedFiles(workspaceId: string, absolutePaths: string[]): Promise<void> {
    this.assertMayMutate("removeTrackedFiles");
    if (absolutePaths.length === 0) {
      return;
    }
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.ensureWorkspaceMayUploadFiles(workspaceId);
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const remoteManifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remoteManifest) {
      throw new Error("manifest missing on cloud");
    }
    const now = new Date().toISOString();
    const localCopy: CloudManifest = {
      ...remoteManifest,
      updatedAt: now,
      machines: this.touchMachine(remoteManifest.machines, now),
      files: [...remoteManifest.files],
    };
    const meta = await this.pullMeta(workspaceId, entry.metaEtag);

    // Two passes on purpose. Deletion used to happen inside the same loop that
    // built the tombstones, while the mass-change guard only runs later, inside
    // `putManifest`. By the time the user was asked "about to tombstone 500
    // files, continue?" all 500 blobs were already gone — and answering "no"
    // left the data deleted and the manifest untouched, the worst of both.
    // Pass 1 computes what the manifest would become and asks; pass 2 deletes.
    // Link Bindings: `key` is the canonical manifest/_meta/blob key; `posixRel`
    // stays the local placement (matches cfg.files[].localPath below).
    const plannedRemovals: { posixRel: string; key: string; cloudPath: string }[] = [];
    for (const abs of absolutePaths) {
      const posixRel = this.posixRel(cfg, abs);
      const tracked = this.findTracked(cfg, workspaceId, posixRel);
      const key = tracked ? manifestKeyOf(tracked) : posixRel;
      const cloudPath =
        tracked?.cloudPath ??
        blobCloudPath(workspaceId, key, meta.files[key]?.wireGzip === true);
      plannedRemovals.push({ posixRel, key, cloudPath });
    }

    for (const { key } of plannedRemovals) {
      tombstoneManifestKey(localCopy.files, key, now, this.nextManifestVersion(localCopy.files));
    }

    // Ask before anything is destroyed.
    if (this.deps.onMassChange) {
      const report = detectMassChange(remoteManifest, localCopy);
      if (report.triggered) {
        const proceed = await this.deps.onMassChange(workspaceId, report);
        if (!proceed) {
          throw new WorkspacePolicyError(
            "VSCodeSync: удаление отменено пользователем (защита от массового изменения). Ничего не удалено.",
          );
        }
      }
    }

    for (const { posixRel, key, cloudPath } of plannedRemovals) {
      try {
        await this.deps.provider.deleteFile(cloudPath);
      } catch (e) {
        if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
          throw e;
        }
      }
      meta.files = Object.fromEntries(
        Object.entries(meta.files).filter(([metaKey]) => metaKey !== key),
      );
      this.fireActivity({
        kind: "remove",
        workspaceId,
        workspaceNote: entry.workspaceNote,
        relPath: posixRel,
        machineName: this.deps.machineName,
        provider: this.deps.provider.type,
      });
    }

    const relSet = new Set(plannedRemovals.map((r) => r.posixRel));
    cfg.files = cfg.files.filter((f) => !(f.workspaceId === workspaceId && relSet.has(f.localPath)));

    let diskCfg = await this.loadCfg();
    const entDisk = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entDisk) {
      throw new Error("workspace entry lost");
    }
    await this.pushMetaJson(workspaceId, meta, entDisk.metaEtag, "push");
    diskCfg = await this.loadCfg();
    const entAfterMeta = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entAfterMeta) {
      throw new Error("workspace entry lost");
    }
    const merged = mergeCloudManifests(localCopy, remoteManifest);
    await this.putManifest(workspaceId, merged, entAfterMeta.manifestEtag);
    const finalCfg = await this.loadCfg();
    finalCfg.files = cfg.files;
    await this.saveCfg(finalCfg);
  }

  /** Remove file tracking only from local vscodesync.json. Cloud manifest and blob are untouched. */
  async untrackFileLocal(workspaceId: string, absolutePaths: string[]): Promise<void> {
    this.assertMayMutate("untrackFileLocal");
    if (absolutePaths.length === 0) {
      return;
    }
    const cfg = await this.loadCfg();
    const relSet = new Set(absolutePaths.map((a) => this.posixRel(cfg, a)));
    cfg.files = cfg.files.filter((f) => !(f.workspaceId === workspaceId && relSet.has(f.localPath)));
    await this.saveCfg(cfg);
  }

  /**
   * Set tombstone for each path in manifest so all machines stop tracking it,
   * but do NOT delete the cloud blob. Removes from meta + local config.
   */
  async untrackFileTombstoneOnly(workspaceId: string, absolutePaths: string[]): Promise<void> {
    this.assertMayMutate("untrackFileTombstoneOnly");
    if (absolutePaths.length === 0) {
      return;
    }
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.ensureWorkspaceMayUploadFiles(workspaceId);
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const remoteManifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remoteManifest) {
      throw new Error("manifest missing on cloud");
    }
    const now = new Date().toISOString();
    const localCopy: CloudManifest = {
      ...remoteManifest,
      updatedAt: now,
      machines: this.touchMachine(remoteManifest.machines, now),
      files: [...remoteManifest.files],
    };
    const meta = await this.pullMeta(workspaceId, entry.metaEtag);

    for (const abs of absolutePaths) {
      const posixRel = this.posixRel(cfg, abs);
      // Link Bindings: tombstone/meta go by the canonical key of the tracked row.
      const trackedRow = this.findTracked(cfg, workspaceId, posixRel);
      const key = trackedRow ? manifestKeyOf(trackedRow) : posixRel;
      meta.files = Object.fromEntries(
        Object.entries(meta.files).filter(([metaKey]) => metaKey !== key),
      );
      tombstoneManifestKey(localCopy.files, key, now, this.nextManifestVersion(localCopy.files));
    }

    const relSet = new Set(absolutePaths.map((a) => this.posixRel(cfg, a)));
    cfg.files = cfg.files.filter((f) => !(f.workspaceId === workspaceId && relSet.has(f.localPath)));

    let diskCfg = await this.loadCfg();
    const entDisk = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entDisk) {
      throw new Error("workspace entry lost");
    }
    await this.pushMetaJson(workspaceId, meta, entDisk.metaEtag, "push");
    diskCfg = await this.loadCfg();
    const entAfterMeta = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entAfterMeta) {
      throw new Error("workspace entry lost");
    }
    const merged = mergeCloudManifests(localCopy, remoteManifest);
    await this.putManifest(workspaceId, merged, entAfterMeta.manifestEtag);
    const finalCfg = await this.loadCfg();
    finalCfg.files = cfg.files;
    await this.saveCfg(finalCfg);
  }

  /**
   * Rename a tracked file: updates localPath/cloudPath in vscodesync.json,
   * copies cloud blob to new path, sets tombstone for old path and adds new
   * manifest entry with renamedFrom/renamedAt markers.
   */
  async renameTrackedFile(workspaceId: string, oldAbsPath: string, newAbsPath: string): Promise<void> {
    this.assertMayMutate("renameTrackedFile");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const oldRel = this.posixRel(cfg, oldAbsPath);
    const newRel = this.posixRel(cfg, newAbsPath);
    if (oldRel === newRel) {
      return;
    }
    const trackedEntry = this.findTracked(cfg, workspaceId, oldRel);
    if (!trackedEntry) {
      return;
    }

    const remoteManifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!remoteManifest) {
      throw new Error("manifest missing on cloud");
    }

    // Link Bindings: a local move of a BOUND file does not touch the canonical
    // key — it is a rebind: local placement + the row's bindings entry change,
    // no blob copy, no tombstone, no `_meta` move. (Stage 3 adds the modal
    // offering a canonical rename instead.)
    const renameKey = manifestKeyOf(trackedEntry);
    if (renameKey !== oldRel) {
      const nowBind = new Date().toISOString();
      const row = remoteManifest.files.find((f) => f.path === renameKey && !f.removedAt);
      if (row) {
        const updatedRow: ManifestFile = {
          ...row,
          version: Math.max(this.nextManifestVersion(remoteManifest.files), row.version + 1),
          bindings: {
            ...row.bindings,
            [this.deps.machineId]: { path: newRel, boundAt: nowBind },
          },
        };
        await this.putManifest(
          workspaceId,
          {
            ...remoteManifest,
            updatedAt: nowBind,
            machines: this.touchMachine(remoteManifest.machines, nowBind),
            files: remoteManifest.files.map((f) => (f === row ? updatedRow : f)),
          },
          entry.manifestEtag,
        );
      }
      const rebindCfg = await this.loadCfg();
      const ix = rebindCfg.files.findIndex((f) => f.workspaceId === workspaceId && f.localPath === oldRel);
      if (ix >= 0) {
        rebindCfg.files[ix] = { ...rebindCfg.files[ix], localPath: newRel, manifestPath: renameKey };
      }
      await this.saveCfg(rebindCfg);
      return;
    }
    const meta = await this.pullMeta(workspaceId, entry.metaEtag);

    const oldCloudPath = trackedEntry.cloudPath;
    // The new path must carry the same wire encoding as the old one. It used to
    // be built with `trackedFileCloudPath`, i.e. always without the `.gz`
    // suffix, while the `_meta` row was moved across verbatim — `wireGzip: true`
    // included. `pullFile` then asked for `<newRel>.gz`, which did not exist,
    // and the file was NOT_FOUND forever: a plain rename with `compressUploads`
    // on permanently broke the file.
    const renameWireGzip = meta.files[oldRel]?.wireGzip === true;
    const newCloudPath = blobCloudPath(workspaceId, newRel, renameWireGzip);

    // Copy blob: download old, upload to new path. Bytes are moved in their
    // wire form on purpose — no decode/re-encode, so no key is needed here.
    try {
      const dl = await this.deps.provider.downloadFile(oldCloudPath, { signal: this.abortSignal });
      await this.deps.provider.uploadFile(newCloudPath, dl.body, undefined);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
      // Old blob missing — proceed with metadata-only rename
    }
    // Tombstone old blob
    try {
      await this.deps.provider.deleteFile(oldCloudPath);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
    }

    const now = new Date().toISOString();

    // Update meta: move entry from old key to new key
    const oldMetaEntry = meta.files[oldRel];
    if (oldMetaEntry) {
      const { [oldRel]: _moved, ...rest } = meta.files;
      meta.files = { ...rest, [newRel]: { ...oldMetaEntry } };
    }

    // Build updated manifest
    const localCopy: CloudManifest = {
      ...remoteManifest,
      updatedAt: now,
      machines: this.touchMachine(remoteManifest.machines, now),
      files: [...remoteManifest.files],
    };
    const nextVer = this.nextManifestVersion(localCopy.files);
    // Tombstone old entry
    const oldIx = localCopy.files.findIndex((f) => f.path === oldRel);
    if (oldIx >= 0) {
      const prev = localCopy.files[oldIx];
      localCopy.files[oldIx] = {
        ...prev,
        removedAt: now,
        version: Math.max(nextVer, prev.version + 1),
      };
    }
    // Add new entry with renamedFrom marker. Link Bindings: identity and the
    // other machines' placements travel with the rename — their bindings hold
    // machine-local paths, which a canonical rename does not affect.
    const oldRow = oldIx >= 0 ? remoteManifest.files.find((f) => f.path === oldRel) : undefined;
    const existingNewIx = localCopy.files.findIndex((f) => f.path === newRel);
    const newManifestFile: ManifestFile = {
      path: newRel,
      addedAt: now,
      version: this.nextManifestVersion(localCopy.files),
      hasSyncignoreMarkers: trackedEntry.syncStatus === "ok" ? false : trackedEntry.syncStatus === "conflict",
      renamedFrom: oldRel,
      renamedAt: now,
      ...(oldRow?.linkId !== undefined ? { linkId: oldRow.linkId } : {}),
      ...(oldRow?.linkName !== undefined ? { linkName: oldRow.linkName } : {}),
      ...(oldRow?.bindings !== undefined ? { bindings: { ...oldRow.bindings } } : {}),
    };
    if (existingNewIx >= 0) {
      localCopy.files[existingNewIx] = { ...localCopy.files[existingNewIx], ...newManifestFile };
    } else {
      localCopy.files.push(newManifestFile);
    }

    // Update local tracking entry
    trackedEntry.localPath = newRel;
    trackedEntry.cloudPath = newCloudPath;

    let diskCfg = await this.loadCfg();
    const entDisk = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entDisk) {
      throw new Error("workspace entry lost");
    }
    await this.pushMetaJson(workspaceId, meta, entDisk.metaEtag, "push");
    diskCfg = await this.loadCfg();
    const entAfterMeta = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entAfterMeta) {
      throw new Error("workspace entry lost");
    }
    const merged = mergeCloudManifests(localCopy, remoteManifest);
    await this.putManifest(workspaceId, merged, entAfterMeta.manifestEtag);

    const finalCfg = await this.loadCfg();
    // Patch the tracked entry in the loaded config
    const localIdx = finalCfg.files.findIndex((f) => f.workspaceId === workspaceId && f.localPath === oldRel);
    if (localIdx >= 0) {
      finalCfg.files[localIdx] = { ...finalCfg.files[localIdx], localPath: newRel, cloudPath: newCloudPath };
    }
    await this.saveCfg(finalCfg);
  }

  private async fileHasSyncMarkers(abs: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(abs, "utf8");
      return extractSyncignoreInners(raw).length > 0;
    } catch {
      return false;
    }
  }

  private nextManifestVersion(files: ManifestFile[]): number {
    let m = 0;
    for (const f of files) {
      if (f.version > m) {
        m = f.version;
      }
    }
    return m + 1;
  }

  /** Delegates to `touchManifestMachine` (machineRegistry.ts). */
  private touchMachine(machines: CloudManifest["machines"], now: string): CloudManifest["machines"] {
    return touchManifestMachine(machines, now, {
      machineId: this.deps.machineId,
      machineName: this.deps.machineName,
      requireApproval: this.deps.requireMachineApproval?.() === true,
    });
  }

  private async downloadManifest(
    workspaceId: string,
    ifNoneMatch: string | undefined,
  ): Promise<CloudManifest | null> {
    return this.manifestStore.download(workspaceId, ifNoneMatch);
  }

  /** Manifest was deleted from cloud while workspace still exists locally — rebuild from tracked files and re-upload. */
  private async rebuildManifestFromLocalState(
    workspaceId: string,
    cfg: WorkspaceConfig,
    entry: ActiveWorkspaceEntry,
  ): Promise<void> {
    const now = new Date().toISOString();
    // Builder in linkIdentity.ts: canonical keys + re-asserted own placement.
    const manifestFiles = rebuildManifestFilesFromTracked(
      cfg.files.filter((f) => f.workspaceId === workspaceId),
      this.deps.machineId,
      now,
    );
    const manifest: CloudManifest = {
      schemaVersion: SUPPORTED_MANIFEST_SCHEMA,
      workspaceId,
      workspaceNote: entry.workspaceNote,
      tags: entry.tags ?? [],
      sharedIgnorePatterns: entry.sharedIgnorePatterns ?? [],
      providerType: entry.providerType ?? this.deps.provider.type,
      createdAt: now,
      updatedAt: now,
      machines: [{ machineId: this.deps.machineId, machineName: this.deps.machineName, lastSeen: now }],
      files: manifestFiles,
    };
    const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const up = await this.deps.provider.uploadFile(manifestCloudPath(workspaceId), body);
    const metaBody = Buffer.from(`${JSON.stringify(EMPTY_META_JSON, null, 2)}\n`, "utf8");
    const metaUp = await this.deps.provider.uploadFile(metaCloudPath(workspaceId), metaBody);
    await this.patchEntry(workspaceId, {
      manifestEtag: up.etag,
      metaEtag: metaUp.etag,
      ...entryPatchFromManifest(manifest),
    });
    this.cacheManifest(workspaceId, manifest, up.etag);
    this.metaStore.put(workspaceId, EMPTY_META_JSON);
  }

  /** Purge tombstone entries older than `tombstonePurgeDays` and stale `renamedFrom` markers. */


  /**
   * Resolve a conflict by keeping the local (mine) version: push local file to cloud, clear conflict status.
   *
   * Returns `"cloud_moved"` — without touching the cloud — when the cloud copy
   * is no longer the one recorded when the conflict was flagged: that content
   * was never shown to the user, and "Keep Mine" would bury it (D5). Pass
   * `force` after the user has been told and still wants the local version.
   */
  async resolveConflictKeepMine(
    workspaceId: string,
    posixRel: string,
    opts?: { force?: boolean },
  ): Promise<"pushed" | "cloud_moved" | "not_conflicting"> {
    this.assertMayMutate("resolveConflictKeepMine");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.ensureWorkspaceMayUploadFiles(workspaceId);
    const cfg = await this.loadCfg();
    const file = this.findTracked(cfg, workspaceId, posixRel);
    if (!file) {
      throw new Error(`not tracked: ${posixRel}`);
    }
    if (file.syncStatus !== "conflict") {
      return "not_conflicting";
    }
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    if (opts?.force !== true && (await this.cloudMovedSinceConflict(file))) {
      return "cloud_moved";
    }
    file.syncStatus = "ok";
    file.conflictCloudHash = undefined;
    await this.pushFile(cfg, workspaceId, posixRel, entry, { asAutoResolvedKeepMine: true });
    await this.saveCfg(cfg);
    // A 412 inside `pushFile` re-flags the conflict: the cloud moved between
    // the check above and the upload. Report that instead of claiming success.
    // Re-read through the config so we see what `pushFile` actually left.
    const after = this.findTracked(cfg, workspaceId, posixRel);
    return after?.syncStatus === "conflict" ? "cloud_moved" : "pushed";
  }

  /**
   * True when the cloud blob differs from what it was when the conflict was
   * raised. An unknown baseline (412 path) or an unreadable cloud copy answers
   * `false` — this check may warn, never block on its own uncertainty.
   */
  private async cloudMovedSinceConflict(file: TrackedFile): Promise<boolean> {
    const baseline = file.conflictCloudHash;
    if (baseline === undefined || baseline === "") {
      return false;
    }
    try {
      const meta = await this.pullMeta(file.workspaceId, undefined);
      const dl = await this.deps.provider.downloadFile(file.cloudPath, { signal: this.abortSignal });
      const buf = this.decodeCloudBlob(dl.body, meta.files[manifestKeyOf(file)]?.wireGzip === true);
      const current = hashCanonicalBuffer(buf, manifestKeyOf(file), this.hashCfg(manifestKeyOf(file)));
      return current !== baseline;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a conflict by accepting the cloud (theirs) version: pull cloud file, clear conflict status.
   */
  async resolveConflictTakeTheirs(workspaceId: string, posixRel: string): Promise<void> {
    this.assertMayMutate("resolveConflictTakeTheirs");
    await this.ensureWorkspaceNotSuspendedNorFrozen(workspaceId);
    const cfg = await this.loadCfg();
    const file = this.findTracked(cfg, workspaceId, posixRel);
    if (!file) {
      throw new Error(`not tracked: ${posixRel}`);
    }
    if (file.syncStatus !== "conflict") {
      return;
    }
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    file.syncStatus = "ok";
    await this.pullFile(cfg, workspaceId, posixRel, entry);
    this.fireActivity({
      kind: "resolve_take_theirs",
      workspaceId,
      workspaceNote: entry.workspaceNote,
      relPath: posixRel,
      machineName: this.deps.machineName,
      provider: this.deps.provider.type,
    });
  }

  /**
   * v0.8 F-009 — keep both versions of a conflicted file. Cloud blob is
   * downloaded and written to a sibling `<name>.conflict-<machine>-<ts><.ext>`
   * (binary-safe; no merge attempt). LOCAL stays as-is and gets pushed.
   * The local pre-resolve content is backed up to
   * `.vscode/vscodesync-local-backup/conflict-<ts>/<rel>` so an accidental
   * push doesn't lose the local-only edits either.
   */
  async resolveConflictKeepBoth(workspaceId: string, posixRel: string): Promise<void> {
    this.assertMayMutate("resolveConflictKeepBoth");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.ensureWorkspaceMayUploadFiles(workspaceId);
    const cfg = await this.loadCfg();
    const file = this.findTracked(cfg, workspaceId, posixRel);
    if (!file) {
      throw new Error(`not tracked: ${posixRel}`);
    }
    if (file.syncStatus !== "conflict") {
      return;
    }
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }

    const { planKeepBothResolution } = await import("./keepBothConflictResolver.js");
    const remoteLabel = file.editingByName ?? file.editingBy ?? "remote";
    const plan = planKeepBothResolution({ posixRel, remoteMachineLabel: remoteLabel });

    // 1) Backup current local content under `.vscode/vscodesync-local-backup/conflict-<ts>/<rel>`
    const absLocal = this.localAbs(cfg, posixRel);
    try {
      const backupDir = this.resolveLocalBackupDir();
      const dest = path.join(this.deps.workspaceRoot, backupDir, plan.backupFolderName, ...posixRel.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(absLocal, dest);
    } catch (e) {
      warnLog("syncEngine", `keep-both backup failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2) Download cloud blob, write to `<name>.conflict-<machine>-<ts><.ext>`
    const blob = await this.downloadTrackedBlob(posixRel);
    const theirsAbs = path.join(this.deps.workspaceRoot, ...plan.theirsRel.split("/"));
    await fs.mkdir(path.dirname(theirsAbs), { recursive: true });
    await fs.writeFile(theirsAbs, blob.body);

    // 3) Clear conflict on tracked entry — LOCAL stays under its rel
    //    but is now diverging from `_meta.hash`, so we mark `pending_push`
    //    (not `ok`) — otherwise the next status check would re-detect a
    //    conflict against the cloud version. User reviews the `.conflict-...`
    //    sibling, then issues Push (manually in check-only, or auto in full).
    file.syncStatus = "pending_push";
    await this.saveCfg(cfg);
    this.fireActivity({
      kind: "resolve_keep_both",
      workspaceId,
      workspaceNote: entry.workspaceNote,
      relPath: posixRel,
      machineName: this.deps.machineName,
      provider: this.deps.provider.type,
      meta: { rule: "keep-both", theirsRel: plan.theirsRel },
    });
  }

  private async putManifest(
    workspaceId: string,
    manifest: CloudManifest,
    ifMatch: string | undefined,
    retries = 3,
  ): Promise<string | undefined> {
    return this.manifestStore.put(workspaceId, manifest, ifMatch, retries);
  }

  /**
   * v2.3.4 — backfill `hashBlake3` columns for files that already exist in
   * `_meta.json` but were uploaded before the workspace started running on
   * `canonicalHashAlgo: "dual"` / `"blake3"`. Reads each tracked file from
   * disk, recomputes the canonical BLAKE3, and writes a single `pushMetaJson`
   * with all updates.
   *
   * Returns a per-task report: how many tasks were applied vs. skipped
   * (missing locally / already had hashBlake3 / hash drift detected).
   */
  async applyHashBlake3Backfill(
    workspaceId: string,
    tasks: { relPath: string; existingSha256: string }[],
  ): Promise<{ applied: number; skippedMissing: number; skippedDrift: number; skippedAlreadyDone: number }> {
    this.assertMayMutate("applyHashBlake3Backfill");
    const cfg = await WorkspaceConfigManager.load(this.deps.workspaceRoot);
    const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!ent) {
      throw new Error(`workspace ${workspaceId} not active`);
    }
    const meta = await this.pullMeta(workspaceId, ent.metaEtag);
    const updated: MetaJson = { ...meta, files: { ...meta.files } };
    // Loop extracted to `planBlake3Backfill.ts`. Link Bindings: `relPath` is a
    // canonical meta key — the bytes live at the machine's own placement.
    const { applied, skippedMissing, skippedDrift, skippedAlreadyDone } = await runBlake3BackfillTasks(
      updated,
      tasks,
      {
        readTrackedBytes: async (canonicalRel) => {
          const trackedRow = cfg.files.find(
            (f) => f.workspaceId === workspaceId && manifestKeyOf(f) === canonicalRel,
          );
          return fs.readFile(this.localAbs(cfg, trackedRow?.localPath ?? canonicalRel)).catch(() => null);
        },
        dualHash: (buf, canonicalRel) => hashCanonicalBufferDual(buf, canonicalRel, this.hashCfg(canonicalRel)),
      },
    );
    if (applied > 0) {
      await this.pushMetaJson(workspaceId, updated, ent.metaEtag, "push");
    }
    return { applied, skippedMissing, skippedDrift, skippedAlreadyDone };
  }

  private async pullMeta(workspaceId: string, ifNoneMatch: string | undefined): Promise<MetaJson> {
    return this.metaStore.pull(workspaceId, ifNoneMatch);
  }

  /**
   * `reason` is required: every `_meta` write states whether it records a push
   * or completes a pull. The distinction used to travel through a process-wide
   * depth counter (`withPullCloudMetaWriteAllowed`) — while any parallel pull
   * held the window open, an unrelated push on a read-only secondary instance
   * slipped through the check (F7). An argument cannot leak across operations.
   */
  private async pushMetaJson(
    workspaceId: string,
    meta: MetaJson,
    ifMatch: string | undefined,
    reason: MetaWriteReason,
  ): Promise<string> {
    return this.metaStore.push(workspaceId, meta, ifMatch, reason);
  }

  /**
   * Everything a pass over a workspace needs before it looks at a single file.
   *
   * Extracted so the detector and the full sync stop being the same method with
   * a flag. The flag reached only `iterateTrackedFiles`; the shared prologue ran
   * regardless, so "check only" adopted files from someone else's manifest,
   * pruned tracked entries, and — on a NOT_FOUND manifest — detached the
   * workspace outright. That is `checkOnly` in name and a mutation in fact.
   */
  private async loadWorkspaceSyncContext(workspaceId: string): Promise<{
    cfg: WorkspaceConfig;
    manifest: CloudManifest;
    trackedFiles: TrackedFile[];
    meta: MetaJson;
  } | null> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const manifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!manifest) {
      // Reached only when the provider answered NOT_FOUND. A manifest that
      // exists but fails to parse throws `ManifestCorruptError` instead, so it
      // can no longer be mistaken for a deletion.
      //
      // Manifest is gone from cloud — regardless of whether the folder has leftover content,
      // treat this as intentional deletion by another machine.
      //
      // Detaching drops the workspace and every one of its tracked entries from
      // the local config. On the check-only path that ran unconditionally, so a
      // background status tick destroyed local tracking state on the strength of
      // a NOT_FOUND from the cloud. The finding is reported either way; only a
      // user-triggered run acts on it.
      const savedEntry = { ...entry };
      const savedFiles = cfg.files.filter((f) => f.workspaceId === workspaceId);
      const detached = this.mayMutate("detachWorkspaceLocal");
      if (detached) {
        await this.detachWorkspaceLocalInternal(workspaceId);
      }
      this.deps.onRemoteWorkspaceDeleted?.(
        workspaceId,
        entry.workspaceNote,
        this.deps.workspaceRoot,
        savedEntry,
        savedFiles,
        detached,
      );
      return null;
    }

    // Forward-compat: if the cloud manifest has a newer schemaVersion, skip sync
    // and notify the user to update their extension.
    const rawSchema = (manifest as unknown as { schemaVersion: number }).schemaVersion;
    if (rawSchema > SUPPORTED_MANIFEST_SCHEMA) {
      this.deps.onSchemaVersionTooNew?.(workspaceId, rawSchema);
      return null;
    }

    // Detect files that would be silently pruned (tombstone purged while offline)
    // but still exist on disk — warn the user so they're not lost without notice.
    if (this.deps.onPurgeLostFiles) {
      const activePaths = new Set(manifest.files.filter((f) => !f.removedAt).map((f) => f.path));
      const wouldBePruned = cfg.files.filter(
        (f) => f.workspaceId === workspaceId && !activePaths.has(manifestKeyOf(f)),
      );
      if (wouldBePruned.length > 0) {
        const lost: PurgeLostFileItem[] = [];
        for (const f of wouldBePruned) {
          const absPath = this.localAbs(cfg, f.localPath);
          try {
            await fs.access(absPath);
            lost.push({ workspaceId, workspaceNote: entry.workspaceNote, relPath: f.localPath });
          } catch {
            // File doesn't exist locally — silent prune is fine
          }
        }
        if (lost.length > 0) {
          this.deps.onPurgeLostFiles(lost);
        }
      }
    }

    // Adopting files another machine added, and pruning entries it removed,
    // changes *what this machine tracks*. No byte moves either way, but the
    // local tracking list is the user's, so a background pass reports the drift
    // and leaves it alone; a user-triggered pass applies it as before.
    if (this.mayMutate("applyTrackingFromCloud")) {
      // Adopt before pruning: `renamedFrom` detection needs the old entry to
      // still be in `cfg.files`.
      await this.adoptManifestFilesFromCloud(workspaceId);
      // Reload cfg after adoption (adoptManifestFilesFromCloud saves its own copy)
      const cfgAfterAdopt = await this.loadCfg();
      this.pruneTrackingFromManifest(cfgAfterAdopt, manifest);
      await this.saveCfg(cfgAfterAdopt);
    } else {
      this.reportTrackingDrift(cfg, workspaceId, entry.workspaceNote, manifest, entry.syncScopes);
    }

    if (normalizeWorkspaceSyncState(entry) !== "active") {
      return null;
    }

    // Use the fresh config after adopt + prune
    const cfgSync = await this.loadCfg();
    const trackedFiles = cfgSync.files.filter((f) => f.workspaceId === workspaceId);

    // Update soft lock cache from manifest
    const machineById = new Map(entry.manifestMachines?.map((m) => [m.machineId, m.machineName]) ?? []);
    for (const file of trackedFiles) {
      const mf = manifest.files.find((x) => x.path === manifestKeyOf(file) && !x.removedAt);
      const newEditingBy = mf?.editingBy && mf.editingBy !== this.deps.machineId ? mf.editingBy : undefined;
      if (file.editingBy !== newEditingBy) {
        file.editingBy = newEditingBy;
        file.editingByName = newEditingBy ? (machineById.get(newEditingBy) ?? newEditingBy) : undefined;
      }
    }

    // Pull meta once — pushFile/pullFile update this.metaByWs so subsequent iterations read from
    // cache, eliminating N getMetadata(_meta.json) HTTP round-trips for N tracked files.
    const entInit = cfgSync.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entInit) {
      return null;
    }
    const meta = await this.pullMeta(workspaceId, entInit.metaEtag);

    // Link Bindings self-heal: re-assert this machine's bindings a v1 merge
    // may have dropped. User passes only (bindingSelfHealState owns the
    // once-per-session rate limit).
    if (this.mayMutate("putManifest")) {
      await runBindingSelfHeal({
        workspaceRoot: this.deps.workspaceRoot,
        workspaceId,
        machineId: this.deps.machineId,
        manifest,
        trackedFiles,
        nextVersion: this.nextManifestVersion(manifest.files),
        nowIso: new Date().toISOString(),
        putManifest: (m) => this.putManifest(workspaceId, m, entInit.manifestEtag),
      });
    }

    return { cfg: cfgSync, manifest, trackedFiles, meta };
  }

  /**
   * Report tracking composition that differs from the cloud manifest without
   * changing it. This is what the detector produces instead of adopting and
   * pruning on its own; the panel and the notification turn it into a choice.
   */
  private reportTrackingDrift(
    cfg: WorkspaceConfig,
    workspaceId: string,
    workspaceNote: string,
    manifest: CloudManifest,
    scopes?: readonly string[],
  ): void {
    if (!this.deps.onTrackingDriftDetected) return;
    // Same planner the adoption uses, so the notification cannot promise a
    // different set of changes than the action would apply. `existsLocally` is
    // irrelevant to the counts, so the detector answers it cheaply.
    const diff = planTrackingDiff({
      workspaceId,
      // Same scope filter as the adoption pass: a folder this machine does not
      // carry must not be reported as drift either.
      manifestFiles: manifest.files.filter((f) => isInSyncScope(scopes, f.path)),
      // Link Bindings: same canonical-key feed as the adoption pass — a bound
      // file otherwise reads as a perpetual adopt+prune drift.
      trackedPaths: cfg.files
        .filter((f) => f.workspaceId === workspaceId && isInSyncScope(scopes, manifestKeyOf(f)))
        .map((f) => manifestKeyOf(f)),
      metaHashFor: () => undefined,
      wireGzipFor: () => false,
      existsLocally: () => false,
    });
    const toAdopt = [...diff.adopt.map((a) => a.posixRel), ...diff.rename.map((r) => r.to)];
    const toPrune = diff.prune;
    if (toAdopt.length === 0 && toPrune.length === 0) return;
    this.deps.onTrackingDriftDetected({ workspaceId, workspaceNote, toAdopt, toPrune });
  }

  /**
   * Bring the local tracking list in line with the cloud manifest — the
   * user-driven half of what the detector only reports.
   */
  async applyTrackingFromCloud(workspaceId: string): Promise<void> {
    this.assertMayMutate("applyTrackingFromCloud");
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const manifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!manifest) return;
    await this.adoptManifestFilesFromCloud(workspaceId);
    const cfgAfterAdopt = await this.loadCfg();
    this.pruneTrackingFromManifest(cfgAfterAdopt, manifest);
    await this.saveCfg(cfgAfterAdopt);
  }

  async syncWorkspace(workspaceId: string): Promise<void> {
    this.assertMayMutate("syncWorkspace");
    // v0.7 — opportunistically drain any deferred history snapshots queued by
    // `historyMode = lazy` since the last sync. Cheap when the queue is empty;
    // bounded by `historyVersions` per file otherwise. Uploading them is a cloud
    // write, which is why it lives here and not in the shared prologue.
    if (this.historyStore.pending() > 0) {
      const drained = this.drainLazyHistoryQueue();
      try {
        await this.runDeferredHistorySnapshots(drained);
      } catch (e) {
        warnLog("syncEngine", `lazy history drain failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const ctx = await this.loadWorkspaceSyncContext(workspaceId);
    if (!ctx) return;
    await this.iterateTrackedFiles(ctx.cfg, workspaceId, ctx.manifest, ctx.trackedFiles, ctx.meta, false);
  }

  /**
   * v0.7 — bounded-concurrency tracked-file iteration shared by
   * `syncWorkspace` and `checkWorkspaceStatus`. When `checkOnly` is true,
   * the per-file decision is recorded as `syncStatus` only — no push, no
   * pull, no conflict-rule application.
   */
  private async iterateTrackedFiles(
    cfgSync: WorkspaceConfig,
    workspaceId: string,
    manifest: CloudManifest,
    trackedFiles: TrackedFile[],
    metaNow: MetaJson,
    checkOnly: boolean,
  ): Promise<void> {
    await this.withBatchedCfgWrites(cfgSync, async () => {
      const fileConcurrency = this.resolveFileConcurrency();
      await parallelLimit(
        trackedFiles,
        async (file) => {
          // Cancellation lands between files (A5): the request in flight
          // finishes, nothing new starts.
          this.assertNotCancelled(checkOnly ? "проверка расхождений" : "синхронизация");
          const m = manifest.files.find((x) => x.path === manifestKeyOf(file) && !x.removedAt);
          if (!m) return;
          if (file.syncStatus === "conflict") return;
          const ent = cfgSync.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
          if (!ent) return;
          // Skip files currently under a user-initiated pull/push to avoid
          // overwriting `syncStatus = "ok"` that was just persisted while the
          // cloud meta upload is still in flight.
          if (this.isOpInFlight(workspaceId, file.localPath)) {
            return;
          }
          // Soft lock: another machine is editing — indication only.
          // The actual sync status must reflect hash reality (checkOneFileStatus),
          // not an unconditional override; otherwise a manual Pull would be
          // immediately rolled back to "cloud_newer" on the next tick.
          // Auto-push is blocked elsewhere (syncTriggerManager checks file.editingBy).
          if (m.editingBy && m.editingBy !== this.deps.machineId) {
            await this.checkOneFileStatus(cfgSync, file, metaNow);
            return;
          }
          if (checkOnly) {
            await this.checkOneFileStatus(cfgSync, file, metaNow);
          } else {
            await this.syncOneFile(cfgSync, workspaceId, file, metaNow, ent);
          }
        },
        { concurrency: fileConcurrency },
      );
    });
  }

  /**
   * v0.7 — pure status check for one file: compares local canonical hash
   * against cloud `_meta` + blob hash, updates `file.syncStatus`, never
   * pushes, pulls, or applies conflict rules. Used by `autoSyncMode = check-only`.
   */
  private async checkOneFileStatus(
    cfg: WorkspaceConfig,
    file: TrackedFile,
    meta: MetaJson,
  ): Promise<void> {
    const metaRow = meta.files[manifestKeyOf(file)];
    const base = metaRow === undefined ? undefined : metaRow.hash;
    const localCurrent = await this.hashTrackedFile(this.localAbs(cfg, file.localPath), manifestKeyOf(file)).catch(() => "");
    let cloudCurrent = "";
    try {
      const dl = await this.deps.provider.downloadFile(file.cloudPath, { ifNoneMatch: metaRow?.etag, signal: this.abortSignal });
      if (dl.notModified) {
        cloudCurrent = base ?? "";
      } else {
        const plain = this.decodeCloudBlob(dl.body, metaRow?.wireGzip === true);
        cloudCurrent = hashCanonicalBuffer(plain, manifestKeyOf(file), this.hashCfg(manifestKeyOf(file)));
      }
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
      cloudCurrent = "";
    }
    const { action } = planFileAction({
      baseHash: base,
      cachedLocalHash: file.localHash,
      localHash: localCurrent,
      cloudHash: cloudCurrent,
    });
    const next = syncStatusForAction(action, localCurrent === "");
    if (file.syncStatus !== next) {
      verboseLog(
        "syncEngine",
        `checkOneFileStatus ${file.localPath}: ${String(file.syncStatus)} → ${next} ` +
          `(base=${base?.slice(0, 8) ?? "∅"} local=${localCurrent.slice(0, 8) || "∅"} ` +
          `cloud=${cloudCurrent.slice(0, 8) || "∅"} etag=${metaRow ? metaRow.etag.slice(0, 8) : "∅"})`,
      );
      file.syncStatus = next;
      await this.persistMutatedCfg(cfg);
    }
  }

  /**
   * v0.7 — status-only sync. Same manifest/adopt/prune prep as
   * `syncWorkspace`, but the per-file pass only updates `syncStatus`.
   * Surface this from auto-triggers when `vscodesync.autoSyncMode` is
   * `check-only` — no file content moves until the user invokes Push/Pull.
   */
  /**
   * The divergence detector: reads the manifest, hashes locally, records
   * `syncStatus`. Writes nothing else — no blob, no manifest, no `_meta`, no
   * change to which files are tracked. This is the one pass a background source
   * is allowed to run, so its guarantees have to hold without a checkpoint.
   */
  async checkWorkspaceStatus(workspaceId: string): Promise<void> {
    const ctx = await this.loadWorkspaceSyncContext(workspaceId);
    if (!ctx) return;
    await this.iterateTrackedFiles(ctx.cfg, workspaceId, ctx.manifest, ctx.trackedFiles, ctx.meta, true);
  }

  private pruneTrackingFromManifest(cfg: WorkspaceConfig, manifest: CloudManifest): void {
    const active = new Set(
      manifest.files.filter((f) => !f.removedAt).map((f) => `${manifest.workspaceId}:${f.path}`),
    );
    cfg.files = cfg.files.filter((f) => {
      if (f.workspaceId !== manifest.workspaceId) {
        return true;
      }
      return active.has(`${f.workspaceId}:${manifestKeyOf(f)}`);
    });
  }

  private async syncOneFile(
    cfg: WorkspaceConfig,
    workspaceId: string,
    file: TrackedFile,
    meta: MetaJson,
    entry: ActiveWorkspaceEntry,
  ): Promise<void> {
    this.assertMayMutate("syncOneFile");
    const metaRow = meta.files[manifestKeyOf(file)];
    const base = metaRow === undefined ? undefined : metaRow.hash;
    const localCurrent = await this.hashTrackedFile(this.localAbs(cfg, file.localPath), manifestKeyOf(file)).catch(() => "");
    let cloudCurrent = "";
    let cloudBuf: Buffer | undefined;
    try {
      const dl = await this.deps.provider.downloadFile(file.cloudPath, { ifNoneMatch: metaRow?.etag, signal: this.abortSignal });
      if (dl.notModified) {
        cloudCurrent = base ?? "";
      } else {
        cloudBuf = this.decodeCloudBlob(dl.body, metaRow?.wireGzip === true);
        cloudCurrent = hashCanonicalBuffer(cloudBuf, manifestKeyOf(file), this.hashCfg(manifestKeyOf(file)));
      }
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
      cloudCurrent = "";
    }
    const planned = planFileAction({
      baseHash: base,
      cachedLocalHash: file.localHash,
      localHash: localCurrent,
      cloudHash: cloudCurrent,
    });
    if (planned.reason === "consensus_lag") {
      // `_meta` already updated by another machine; our cached `localHash` lags
      // behind consensus. Report it and let the user pull — a full sync must
      // not silently overwrite what they pushed.
      if (file.syncStatus !== "cloud_newer") {
        file.syncStatus = "cloud_newer";
        await this.persistMutatedCfg(cfg);
      }
      return;
    }
    const action = planned.action;
    if (action === "push") {
      if (file.syncStatus === "cloud_newer") {
        file.syncStatus = "ok";
      }
      if (isSecondaryWorkspaceInstanceReadOnly()) {
        return;
      }
      if (await this.shouldSkipPushDueToMachineApproval(workspaceId)) {
        return;
      }
      if (await fileLooksBinary(this.localAbs(cfg, file.localPath))) {
        return;
      }
      await this.pushFile(cfg, workspaceId, file.localPath, entry);
    } else if (action === "none") {
      if (file.syncStatus === "cloud_newer" || file.syncStatus === "missing_local") {
        file.syncStatus = "ok";
        await this.persistMutatedCfg(cfg);
      }
    } else if (action === "pull") {
      // Absent bytes refine "pull" to the honest missing_local state.
      const pullStatus = syncStatusForAction(action, localCurrent === "");
      if (file.syncStatus !== pullStatus) {
        file.syncStatus = pullStatus;
        await this.persistMutatedCfg(cfg);
      }
    } else {
      // action === "conflict"
      if (
        await this.tryAutoResolvePreserveLineEndingConflict(
          cfg,
          workspaceId,
          file,
          entry,
          cloudBuf,
          localCurrent,
          cloudCurrent,
        )
      ) {
        return;
      }
      if (file.syncStatus === "conflict") {
        return;
      }
      file.syncStatus = "conflict";
      file.conflictCloudHash = cloudCurrent;
      await this.persistMutatedCfg(cfg);
      if (this.deps.onNewConflict) {
        const isBin = await fileLooksBinary(this.localAbs(cfg, file.localPath)).catch(() => false);
        this.deps.onNewConflict(workspaceId, entry.workspaceNote, file.localPath, isBin);
      }
      await this.notifyPreserveLineEndingConflictIfNeeded(cfg, file, cloudBuf, localCurrent, cloudCurrent);
      this.fireActivity({
        kind: "conflict",
        workspaceId,
        workspaceNote: entry.workspaceNote,
        relPath: file.localPath,
        machineName: this.deps.machineName,
        provider: this.deps.provider.type,
      });
    }
  }

  /**
   * План синхронизации без записи `vscodesync.json` и без обновления ETag в проекте
   * (только GET из облака + локальный хэш). Логика совпадает с `syncOneFile` до push/pull.
   */
  /** Delegates to `buildSyncPreview` (syncPreview.ts). */
  async previewSyncPlan(workspaceId?: string): Promise<SyncPreviewWorkspace[]> {
    const cfg = await this.loadCfg();
    return buildSyncPreview({
      cfg,
      workspaceIds: workspaceId ? [workspaceId] : this.workspaceIdsForCurrentProvider(cfg.activeWorkspaces),
      provider: this.deps.provider,
      decodeCloudBlob: (body, wireGzip) => this.decodeCloudBlob(body, wireGzip),
      hashLocalTracked: (localPath, key) =>
        this.hashTrackedFile(this.localAbs(cfg, localPath), key).catch(() => ""),
      hashCloudBuffer: (buf, key) => hashCanonicalBuffer(buf, key, this.hashCfg(key)),
    });
  }

  /**
   * Same 3-way rules as syncOneFile: blocks upload when cloud is ahead or paths diverged.
   * May call pullFile — must run outside runWithSyncFileLock(..., "push", ...) to avoid deadlock.
   * Returns true when the caller should proceed with blob upload.
   */
  private async reconcileBeforePushUpload(
    cfg: WorkspaceConfig,
    workspaceId: string,
    file: TrackedFile,
    meta: MetaJson,
    entry: ActiveWorkspaceEntry,
    localCurrentHash: string,
    activityHint?: { pushOnCommit?: boolean; asAutoResolvedKeepMine?: boolean },
  ): Promise<boolean> {
    if (activityHint?.asAutoResolvedKeepMine === true) {
      return true;
    }

    const metaRow = meta.files[manifestKeyOf(file)];
    const base = metaRow === undefined ? undefined : metaRow.hash;
    let cloudCurrent = "";
    let cloudBuf: Buffer | undefined;
    try {
      const dl = await this.deps.provider.downloadFile(file.cloudPath, { signal: this.abortSignal });
      cloudBuf = this.decodeCloudBlob(dl.body, metaRow?.wireGzip === true);
      cloudCurrent = hashCanonicalBuffer(cloudBuf, manifestKeyOf(file), this.hashCfg(manifestKeyOf(file)));
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
      cloudCurrent = "";
    }

    const planned = planFileAction({
      baseHash: base,
      cachedLocalHash: file.localHash,
      localHash: localCurrentHash,
      cloudHash: cloudCurrent,
    });
    if (planned.reason === "consensus_lag") {
      await this.pullFile(cfg, workspaceId, file.localPath, entry, meta);
      return false;
    }

    const action = planned.action;
    if (action === "push") {
      if (isSecondaryWorkspaceInstanceReadOnly()) {
        return false;
      }
      if (await this.shouldSkipPushDueToMachineApproval(workspaceId)) {
        return false;
      }
      return true;
    }
    if (action === "pull") {
      await this.pullFile(cfg, workspaceId, file.localPath, entry, meta);
      return false;
    }
    if (action === "none") {
      const lastMs = Date.parse(file.lastSync);
      const lastSyncStale =
        !Number.isFinite(lastMs) ||
        Date.now() - lastMs >= LAST_SYNC_REFRESH_THROTTLE_MS;
      const hashOrStatusDrifted =
        file.localHash !== localCurrentHash || file.syncStatus !== "ok";
      if (hashOrStatusDrifted || lastSyncStale) {
        file.localHash = localCurrentHash;
        file.lastSync = new Date().toISOString();
        file.syncStatus = "ok";
        await this.persistMutatedCfg(cfg);
      }
      return false;
    }

    if (
      await this.tryAutoResolvePreserveLineEndingConflict(
        cfg,
        workspaceId,
        file,
        entry,
        cloudBuf,
        localCurrentHash,
        cloudCurrent,
      )
    ) {
      return false;
    }
    if (file.syncStatus === "conflict") {
      return false;
    }
    file.syncStatus = "conflict";
    file.conflictCloudHash = cloudCurrent;
    await this.persistMutatedCfg(cfg);
    if (this.deps.onNewConflict) {
      const isBin = await fileLooksBinary(this.localAbs(cfg, file.localPath)).catch(() => false);
      this.deps.onNewConflict(workspaceId, entry.workspaceNote, file.localPath, isBin);
    }
    await this.notifyPreserveLineEndingConflictIfNeeded(cfg, file, cloudBuf, localCurrentHash, cloudCurrent);
    this.fireActivity({
      kind: "conflict",
      workspaceId,
      workspaceNote: entry.workspaceNote,
      relPath: file.localPath,
      machineName: this.deps.machineName,
      provider: this.deps.provider.type,
    });
    return false;
  }

  async pushAll(
    workspaceId?: string,
    onProgress?: (ev: PushAllProgressEvent) => void,
  ): Promise<PushAllResult[]> {
    this.assertMayMutate("pushAll");
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg = await this.loadCfg();
    const ids = workspaceId
      ? [workspaceId]
      : this.workspaceIdsForCurrentProvider(cfg.activeWorkspaces);
    const fileConcurrency = this.resolveFileConcurrency();
    const workspaceConcurrency = this.resolveWorkspaceConcurrency();
    const results: PushAllResult[] = new Array<PushAllResult>(ids.length);
    let finishedIndex = 0;
    // Errors propagate as they did historically — callers that need
    // per-workspace failure containment (Bulk Push wizard) wrap each id in
    // their own try/catch instead of asking pushAll to swallow.
    await parallelLimit(
      ids,
      async (id, idx) => {
        this.assertNotCancelled("отправка в облако");
        const note =
          cfg.activeWorkspaces.find((w) => w.workspaceId === id)?.workspaceNote ?? id;
        onProgress?.({
          kind: "workspace_started",
          workspaceId: id,
          workspaceNote: note,
          index: idx,
          total: ids.length,
        });
        let pushedFiles = 0;
        // Push means push. This used to be `syncWorkspace(id)`, so the Push
        // command started with a two-way pass: pulling cloud-newer files over
        // local ones and auto-resolving conflicts before a single byte went
        // up (B17). Now it refreshes statuses the way the detector does —
        // manifest, meta, per-file compare, no data movement — and then only
        // uploads. Adopt/prune still applies here (user-triggered pass).
        const ctxPush = await this.loadWorkspaceSyncContext(id);
        if (ctxPush) {
          await this.iterateTrackedFiles(
            ctxPush.cfg, id, ctxPush.manifest, ctxPush.trackedFiles, ctxPush.meta, true,
          );
        }
        const c2 = await this.loadCfg();
        const entry = c2.activeWorkspaces.find((w) => w.workspaceId === id);
        if (!entry) {
          results[idx] = { workspaceId: id, ok: true, pushedFiles: 0, skipped: "not_active" };
          onProgress?.({
            kind: "workspace_finished",
            workspaceId: id,
            workspaceNote: note,
            index: idx,
            total: ids.length,
            ok: true,
            pushedFiles: 0,
          });
          finishedIndex++;
          return;
        }
        const dirtyFiles = c2.files.filter((x) => x.workspaceId === id && x.syncStatus !== "conflict");
        const failedFiles: { posixRel: string; error: string }[] = [];
        await this.withBatchedCfgWrites(c2, async () => {
          await parallelLimit(
            dirtyFiles,
            async (f) => {
              this.assertNotCancelled("отправка в облако");
              // Per-file isolation: one unreadable or vanished file must not
              // abort the other files of the same workspace.
              try {
                const localHash = await this.hashTrackedFile(this.localAbs(c2, f.localPath), manifestKeyOf(f));
                if (localHash !== f.localHash) {
                  await this.pushFile(c2, id, f.localPath, entry);
                  pushedFiles++;
                }
              } catch (e: unknown) {
                // A workspace-level denial applies to every file equally —
                // recording it per file would let the workspace report success.
                if (e instanceof WorkspacePolicyError) throw e;
                const reason = e instanceof Error ? e.message : String(e);
                warnLog("syncEngine", `pushAll: ${f.localPath} пропущен — ${reason}`);
                failedFiles.push({ posixRel: f.localPath, error: reason });
              }
            },
            { concurrency: fileConcurrency },
          );
        });
        results[idx] = {
          workspaceId: id,
          ok: true,
          pushedFiles,
          ...(failedFiles.length > 0 ? { failedFiles } : {}),
        };
        onProgress?.({
          kind: "workspace_finished",
          workspaceId: id,
          workspaceNote: note,
          index: idx,
          total: ids.length,
          ok: true,
          pushedFiles,
        });
        finishedIndex++;
      },
      { concurrency: workspaceConcurrency },
    );
    void finishedIndex; // tracked only for debug if needed; results indexed by `idx`
    return results;
  }

  async pullAll(workspaceId?: string): Promise<void> {
    this.assertMayMutate("pullAll");
    const ids = workspaceId
      ? [workspaceId]
      : this.workspaceIdsForCurrentProvider((await this.loadCfg()).activeWorkspaces);
    const workspaceConcurrency = this.resolveWorkspaceConcurrency();
    await parallelLimit(
      ids,
      async (id) => {
        this.assertNotCancelled("скачивание из облака");
        await this.forcePullWorkspace(id);
      },
      { concurrency: workspaceConcurrency },
    );
  }

  /** Force-pulls every tracked file from cloud, bypassing soft locks and detectChange.
   * Runs the same manifest/adopt/prune prep as syncWorkspace; skips conflict files only. */
  private async forcePullWorkspace(workspaceId: string): Promise<void> {
    this.assertMayMutate("forcePullWorkspace");
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const manifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!manifest) {
      const savedEntry = { ...entry };
      const savedFiles = cfg.files.filter((f) => f.workspaceId === workspaceId);
      // Reached only from `forcePullWorkspace`, which is gated, so the trigger
      // is always "user" here — but ask the policy rather than assume it.
      const detached = this.mayMutate("detachWorkspaceLocal");
      if (detached) {
        await this.detachWorkspaceLocalInternal(workspaceId);
      }
      this.deps.onRemoteWorkspaceDeleted?.(
        workspaceId,
        entry.workspaceNote,
        this.deps.workspaceRoot,
        savedEntry,
        savedFiles,
        detached,
      );
      return;
    }

    const rawSchema = (manifest as unknown as { schemaVersion: number }).schemaVersion;
    if (rawSchema > SUPPORTED_MANIFEST_SCHEMA) {
      this.deps.onSchemaVersionTooNew?.(workspaceId, rawSchema);
      return;
    }

    await this.adoptManifestFilesFromCloud(workspaceId);
    const cfgAfterAdopt = await this.loadCfg();
    this.pruneTrackingFromManifest(cfgAfterAdopt, manifest);
    await this.saveCfg(cfgAfterAdopt);

    if (normalizeWorkspaceSyncState(entry) !== "active") {
      return;
    }

    const cfgSync = await this.loadCfg();
    const trackedFiles = cfgSync.files.filter((f) => f.workspaceId === workspaceId);

    // Refresh editingBy cache from manifest (same as syncWorkspace)
    const machineById = new Map(entry.manifestMachines?.map((m) => [m.machineId, m.machineName]) ?? []);
    for (const file of trackedFiles) {
      const mf = manifest.files.find((x) => x.path === manifestKeyOf(file) && !x.removedAt);
      const newEditingBy = mf?.editingBy && mf.editingBy !== this.deps.machineId ? mf.editingBy : undefined;
      if (file.editingBy !== newEditingBy) {
        file.editingBy = newEditingBy;
        file.editingByName = newEditingBy ? (machineById.get(newEditingBy) ?? newEditingBy) : undefined;
      }
    }

    const freshEntry = cfgSync.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!freshEntry) {
      return;
    }
    const fileConcurrency = this.resolveFileConcurrency();
    await this.withBatchedCfgWrites(cfgSync, async () => {
      await parallelLimit(
        trackedFiles,
        async (file) => {
          this.assertNotCancelled("скачивание из облака");
          if (file.syncStatus === "conflict") return;
          // Intentionally no soft-lock skip: manual pull overrides editingBy
          await this.pullFile(cfgSync, workspaceId, file.localPath, freshEntry);
        },
        { concurrency: fileConcurrency },
      );
    });
  }

  async pushFile(
    cfg: WorkspaceConfig,
    workspaceId: string,
    posixRel: string,
    entry?: ActiveWorkspaceEntry,
    activityHint?: { pushOnCommit?: boolean; asAutoResolvedKeepMine?: boolean },
  ): Promise<void> {
    this.assertMayMutate("pushFile");
    this.assertEncryptionReady();
    // A read-only secondary window must be stopped *before* the blob goes up
    // (F7). Without this check the upload succeeded and only the following
    // `pushMetaJson` threw, leaving an orphaned blob in the cloud that no
    // `_meta` row referenced.
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.ensureWorkspaceMayUploadFiles(workspaceId);
    const ent =
      entry ?? (await this.loadCfg()).activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!ent) {
      throw new Error("no entry");
    }
    const file = this.findTracked(cfg, workspaceId, posixRel);
    if (!file) {
      throw new Error("not tracked");
    }
    // Link Bindings: cloud state is keyed canonically; disk stays local.
    const key = manifestKeyOf(file);
    if (file.syncStatus === "conflict") {
      // Symmetric with `pullFile`: a conflicted file is never moved silently.
      // `pushAll` already filters conflicts out before reaching here, and a
      // stray one is now recorded as a skipped file rather than a false success.
      throw new FileConflictError(posixRel);
    }
    const profileStart = this.deps.onSyncProfileSample ? Date.now() : 0;
    const meta = await this.pullMeta(workspaceId, ent.metaEtag);
    const oldBlobPathForHistory = file.cloudPath;
    const abs = this.localAbs(cfg, posixRel);
    await this.assertFileWithinSizeLimit(abs);
    const hashStartMs = this.deps.onSyncProfileSample ? Date.now() : 0;
    const hash = await this.hashTrackedFile(abs, key);
    let hashMsAccum = this.deps.onSyncProfileSample ? Date.now() - hashStartMs : 0;

    const uploadAllowed = await this.reconcileBeforePushUpload(
      cfg,
      workspaceId,
      file,
      meta,
      ent,
      hash,
      activityHint,
    );
    if (!uploadAllowed) {
      return;
    }

    return runWithSyncFileLock(this.deps.workspaceRoot, posixRel, "push", async () => {
      return this.withInFlightOp(workspaceId, posixRel, async () => {
      await this.ensureWorkspaceMayUploadFiles(workspaceId);
      // v0.7 — re-use the meta we already fetched outside the lock when our
      // own etag is current. `pullMeta` will short-circuit via 304 anyway,
      // but reusing the in-memory copy saves the round-trip entirely.
      const cachedMeta = this.metaStore.peek(workspaceId);
      const metaLocked = cachedMeta ?? (await this.pullMeta(workspaceId, ent.metaEtag));
      const prevLocked = metaLocked.files[key];
      const prevEtagLocked = prevLocked === undefined ? undefined : prevLocked.etag;
      const prevWireGzipLocked = prevLocked?.wireGzip === true;
      await this.historyStore.snapshot(workspaceId, key, oldBlobPathForHistory);
      const plaintextBufLocked = await fs.readFile(abs);
      // Hash the exact bytes we are about to upload.
      //
      // The previous version reused `hash` from the unlocked pre-check and only
      // re-hashed when `plaintextBufLocked.length !== st.size` — comparing a
      // buffer just read from `abs` against a `stat` of the same `abs` taken
      // immediately after. Those agree essentially always, so the "did it change
      // while we waited for the lock" check never fired. When the file *had*
      // been rewritten in between, the new content went to the cloud while
      // `_meta.hash` recorded the hash of the old content: every other machine
      // saw a permanent mismatch and this one believed it was in sync.
      //
      // Hashing the in-memory buffer removes the race by construction and costs
      // no second read of the file.
      const hashStartLocked = this.deps.onSyncProfileSample ? Date.now() : 0;
      const hashLocked = hashCanonicalBuffer(plaintextBufLocked, key, this.hashCfg(key));
      if (this.deps.onSyncProfileSample) {
        hashMsAccum += Date.now() - hashStartLocked;
      }
      // `hash` above stays as it is: it feeds the pre-lock three-way check that
      // decides whether to upload at all. Only the value recorded in `_meta`
      // had to become the hash of the bytes actually sent.

      const encoded = planUploadEncoding({
        workspaceId,
        posixRel: key,
        plaintext: plaintextBufLocked,
        encrypt: this.deps.encrypt,
        decrypt: this.deps.decrypt,
        compressUploads: this.deps.compressUploads,
      });
      const wireGzip = encoded.wireGzip;

      const uploadCloudPath = encoded.cloudPath;
      const pathModeChanged =
        uploadCloudPath !== file.cloudPath ||
        prevWireGzipLocked !== wireGzip ||
        oldBlobPathForHistory !== uploadCloudPath;

      const uploadBuf = encoded.body;

      // "Keep mine" IS the deliberate overwrite of the cloud copy: the user
      // confirmed it in the D5 modal, and the previous cloud version was just
      // copied into `.history` above. Sending `ifMatch` here made the upload
      // fail with 412 exactly when the cloud had moved on — the one case the
      // button exists for — and the 412 branch below re-raised the conflict,
      // so "Всё равно оставить моё" looped forever without ever writing.
      const ifMatchBlob =
        pathModeChanged || activityHint?.asAutoResolvedKeepMine === true ? undefined : prevEtagLocked;
      let etag = prevEtagLocked;
      const networkStartMs = this.deps.onSyncProfileSample ? Date.now() : 0;
      try {
        const res = await this.deps.provider.uploadFile(uploadCloudPath, uploadBuf, { ifMatch: ifMatchBlob, signal: this.abortSignal });
        etag = res.etag ?? etag;
        const networkMs = this.deps.onSyncProfileSample ? Date.now() - networkStartMs : 0;
        // v0.7 — verifyUploadHash setting gate. Default `plaintext-only`
        // keeps the historical behaviour; `never` skips entirely.
        const verifyMode = this.resolveVerifyUploadHash();
        const wantVerify = verifyMode !== "never" && !this.deps.encrypt;
        const verifyStartMs = this.deps.onSyncProfileSample && wantVerify ? Date.now() : 0;
        if (wantVerify) {
          await this.verifyUploadPlaintextHash(uploadCloudPath, hashLocked, key, wireGzip);
        }
        // v0.18 D01 — additional provider-side digest check (shared helper in
        // providerHashVerify.ts). Skip for encrypted uploads (provider sees
        // ciphertext) and wire-compressed uploads (provider digests the .gz).
        if (
          !this.deps.encrypt &&
          !wireGzip &&
          this.resolveProviderHashVerify()
        ) {
          const { verifyProviderContentDigest } = await import("./providerHashVerify.js");
          await verifyProviderContentDigest(this.deps.provider, uploadCloudPath, plaintextBufLocked, posixRel);
        }
        const verifyMs = this.deps.onSyncProfileSample && wantVerify ? Date.now() - verifyStartMs : 0;
        const prevVersion = prevLocked === undefined ? 0 : prevLocked.version;
        const row: MetaEntry = {
          hash: hashLocked,
          etag: etag ?? "",
          version: prevVersion + 1,
          machineId: this.deps.machineId,
          updatedAt: new Date().toISOString(),
        };
        if (wireGzip) {
          row.wireGzip = true;
        }
        const algo = this.deps.canonicalHashAlgo?.() ?? "sha256";
        if (algo !== "sha256") {
          const dual = hashCanonicalBufferDual(plaintextBufLocked, key, this.hashCfg(key));
          row.hashBlake3 = dual.blake3;
        }
        const nextMeta: MetaJson = {
          ...metaLocked,
          files: {
            ...metaLocked.files,
            [key]: row,
          },
        };
        await this.pushMetaJson(workspaceId, nextMeta, ent.metaEtag, "push");
        if (this.deps.onPushFile) {
          try {
            // P2P mirror speaks the canonical namespace shared by peers.
            this.deps.onPushFile(workspaceId, key, plaintextBufLocked, {
              hash: row.hash,
              hashBlake3: row.hashBlake3,
              version: row.version,
            });
          } catch {
            /* P2P mirror is best-effort; cloud upload already succeeded */
          }
        }
        if (uploadCloudPath !== oldBlobPathForHistory) {
          await this.deleteRemoteBlobBestEffort(oldBlobPathForHistory);
        }
        file.cloudPath = uploadCloudPath;
        await this.persistMutatedCfg(cfg);
        if (wireGzip) {
          // `encoded.body` may be encrypted on top of the gzip, but AES-GCM adds
          // a fixed overhead, so the delta still reflects the real saving.
          const saved = plaintextBufLocked.length - encoded.body.length;
          if (saved > 0) {
            this.deps.onCompressionSaving?.(saved);
          }
        }
        file.localHash = hashLocked;
        file.lastSync = new Date().toISOString();
        file.syncStatus = "ok";
        const autoKm = activityHint?.asAutoResolvedKeepMine === true;
        const activityMeta: Record<string, unknown> | undefined = autoKm
          ? { autoResolved: true, rule: "keep-mine" }
          : activityHint?.pushOnCommit
            ? { pushOnCommit: true }
            : undefined;
        this.fireActivity({
          kind: autoKm ? "resolve_keep_mine" : "push",
          workspaceId,
          workspaceNote: ent.workspaceNote,
          relPath: posixRel,
          machineName: this.deps.machineName,
          provider: this.deps.provider.type,
          meta: activityMeta,
        });
        this.emitTransfer({ direction: "upload", bytes: uploadBuf.length });
        if (this.deps.onSyncProfileSample) {
          this.deps.onSyncProfileSample({
            kind: "push",
            workspaceId,
            posixRel,
            bytes: uploadBuf.length,
            totalMs: Date.now() - profileStart,
            hashMs: hashMsAccum,
            networkMs,
            verifyMs,
          });
        }
      } catch (e) {
        if (e instanceof ProviderError && e.code === "PRECONDITION_FAILED") {
          file.syncStatus = "conflict";
          // 412 during upload: the cloud side was never downloaded here, so we
          // have no hash to compare a later "Keep Mine" against.
          file.conflictCloudHash = undefined;
          if (this.deps.onNewConflict) {
            const isBin = await fileLooksBinary(this.localAbs(cfg, posixRel)).catch(() => false);
            this.deps.onNewConflict(workspaceId, ent.workspaceNote, posixRel, isBin);
          }
          this.fireActivity({
            kind: "conflict",
            workspaceId,
            workspaceNote: ent.workspaceNote,
            relPath: posixRel,
            machineName: this.deps.machineName,
            provider: this.deps.provider.type,
            detail: "precondition_failed",
          });
          return;
        }
        // v0.17 D02 — surface STORAGE_QUOTA_EXCEEDED to the UI banner.
        // The activity event uses the existing `quota_critical` kind so
        // weekly digest / stats already count it.
        if (e instanceof ProviderError && e.code === "STORAGE_QUOTA_EXCEEDED") {
          this.deps.onQuotaExhausted?.(workspaceId, posixRel, this.deps.provider.type);
          this.fireActivity({
            kind: "quota_critical",
            workspaceId,
            workspaceNote: ent.workspaceNote,
            relPath: posixRel,
            machineName: this.deps.machineName,
            provider: this.deps.provider.type,
          });
          throw e;
        }
        throw e;
      }
    });
    });
  }

  /**
   * Refuse any blob operation when encryption is switched on but no key reached
   * this engine. Silently falling back to plaintext is the worst of the three
   * possible outcomes: on push it puts readable content into the cloud over
   * encrypted blobs *and* records a matching `_meta.hash`, so nothing ever
   * notices; on pull it overwrites the user's file with ciphertext.
   */
  /**
   * Turn a downloaded blob back into plaintext.
   *
   * The upload pipeline is `plaintext -> [gzip] -> [encrypt] -> upload`, so
   * reading it back means decrypt first, then gunzip. Four comparison sites
   * hashed `dl.body` as-is, which is the *wire* form: with encryption or
   * compression enabled the result could never equal `_meta.hash` (always the
   * plaintext canonical hash), so every such file was reported as a conflict
   * forever, and the same raw bytes were handed to the line-ending comparison.
   */
  private decodeCloudBlob(body: Buffer, wireGzip: boolean): Buffer {
    return this.blobTransfer.decode(body, wireGzip);
  }

  /**
   * Workspaces that belong to the provider currently signed in.
   *
   * `providerType` is cached on the entry from the cloud manifest. Bulk
   * operations used to walk *every* active workspace with whatever provider was
   * active: a workspace created on Google Drive, visited with OneDrive selected,
   * produced NOT_FOUND on its manifest — which the caller reads as "another
   * machine deleted it" and responds to by detaching it locally and wiping its
   * tracking. Entries with no cached `providerType` are kept: they predate the
   * field, and excluding them would be its own kind of silent loss.
   */
  private workspaceIdsForCurrentProvider(entries: readonly ActiveWorkspaceEntry[]): string[] {
    const active = this.deps.provider.type;
    const kept = entries.filter((w) => w.providerType === undefined || w.providerType === active);
    const skipped = entries.length - kept.length;
    if (skipped > 0) {
      verboseLog(
        "syncEngine",
        `пропущено воркспейсов чужого провайдера: ${String(skipped)} (активен ${active})`,
      );
    }
    return [...new Set(kept.map((w) => w.workspaceId))];
  }

  private assertEncryptionReady(): void {
    if (this.deps.encryptionRequired !== true) return;
    if (this.deps.encrypt !== undefined && this.deps.decrypt !== undefined) return;
    throw new Error(
      "VSCodeSync: шифрование включено, но ключ недоступен для этой операции. " +
        "Операция отменена, чтобы не залить открытый текст в облако и не перезаписать файл шифротекстом. " +
        "Проверьте команду «VSCodeSync: Encryption Key» и повторите.",
    );
  }

  private async verifyUploadPlaintextHash(
    cloudPath: string,
    expectedPlaintextHash: string,
    posixRel: string,
    wireGzip: boolean,
  ): Promise<void> {
    return this.blobTransfer.verifyUpload(cloudPath, expectedPlaintextHash, posixRel, wireGzip);
  }

  private async deleteRemoteBlobBestEffort(cloudPath: string): Promise<void> {
    return this.blobTransfer.deleteBestEffort(cloudPath);
  }

  async pullFile(
    cfg: WorkspaceConfig,
    workspaceId: string,
    posixRel: string,
    entry?: ActiveWorkspaceEntry,
    metaIn?: MetaJson,
  ): Promise<"updated" | "already_current"> {
    this.assertMayMutate("pullFile");
    this.assertEncryptionReady();
    return runWithSyncFileLock(this.deps.workspaceRoot, posixRel, "pull", async () => {
    return this.withInFlightOp(workspaceId, posixRel, async () => {
    await this.ensureWorkspaceNotSuspendedNorFrozen(workspaceId);
    const ent =
      entry ?? (await this.loadCfg()).activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!ent) {
      throw new Error("no entry");
    }
    const file = this.findTracked(cfg, workspaceId, posixRel);
    if (!file) {
      throw new Error("not tracked");
    }
    // Link Bindings: canonical key for meta/blob, local path for disk.
    const key = manifestKeyOf(file);
    if (file.syncStatus === "conflict") {
      throw new FileConflictError(posixRel);
    }
    const meta = metaIn ?? (await this.pullMeta(workspaceId, ent.metaEtag));
    const metaRow = meta.files[key];
    const abs = this.localAbs(cfg, posixRel);
    const hadLocal = await fileExists(abs);
    let localCanon = "";
    if (hadLocal) {
      localCanon = await this.hashTrackedFile(abs, key).catch(() => "");
    }
    const localMatchesMetaHash =
      metaRow?.hash !== undefined &&
      metaRow.hash !== "" &&
      localCanon === metaRow.hash;

    /** Conditional GET только если локальный канон уже совпадает с `_meta` для этого etag — иначе 304 без тела при «устаревшем» файле или второй машине без первоначального pull. */
    const ifNoneMatch =
      hadLocal && localMatchesMetaHash && metaRow.etag !== ""
        ? metaRow.etag
        : undefined;
    const wireGzip = metaRow?.wireGzip === true;
    const downloadPath = blobCloudPath(workspaceId, key, wireGzip);
    const dl = await this.deps.provider.downloadFile(downloadPath, {
      ifNoneMatch,
    });
    // X1 — provider digest verify on pull (shared helper mirrors the
    // push-side D01 check). Skip for encrypted reads and wire-compressed
    // blobs; the local canonical hash below covers the common cases.
    if (
      !dl.notModified &&
      !this.deps.decrypt &&
      !wireGzip &&
      this.resolveProviderHashVerify()
    ) {
      const { verifyProviderContentDigest } = await import("./providerHashVerify.js");
      await verifyProviderContentDigest(this.deps.provider, downloadPath, dl.body, `pull ${posixRel}`);
    }
    if (dl.notModified) {
      if (file.localHash !== localCanon || file.syncStatus !== "ok") {
        file.localHash = localCanon;
        file.syncStatus = "ok";
        await this.persistMutatedCfg(cfg);
      }
      return "already_current";
    }
    if (hadLocal && this.deps.localBackupEnabled !== false) {
      await backupLocalWithPrune(abs, this.deps.workspaceRoot, posixRel, this.deps.localBackupRetentionDays ?? 7, this.resolveLocalBackupDir());
    }
    const rawBody: Buffer = this.decodeCloudBlob(dl.body, wireGzip);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (bufferLooksBinary(rawBody)) {
      await fs.writeFile(abs, rawBody);
    } else {
      const oldContent: string | null = hadLocal ? await fs.readFile(abs, "utf8").catch(() => null) : null;
      const mergedText = hadLocal
        ? mergeSyncignoreFromCloud(oldContent ?? "", rawBody.toString("utf8"))
        : rawBody.toString("utf8");
      await fs.writeFile(abs, mergedText, "utf8");
      if (this.deps.onFilePulled) {
        this.deps.onFilePulled(posixRel, oldContent, mergedText);
      }
    }
    const hash = await this.hashTrackedFile(abs, key);
    // Update cloud meta FIRST. Only after the cloud consensus is published
    // do we mark the file locally as "ok" — otherwise a tick that fires in
    // the window between local persist and cloud meta upload would see
    // stale meta, fail the 3-way compare, and roll the status back.
    const priorEtag = metaRow === undefined ? "" : metaRow.etag;
    const priorVer = metaRow === undefined ? 0 : metaRow.version;
    const rowMeta: MetaEntry = {
      hash,
      etag: dl.etag ?? priorEtag,
      version: priorVer + 1,
      machineId: this.deps.machineId,
      updatedAt: new Date().toISOString(),
    };
    if (metaRow?.wireGzip === true) {
      rowMeta.wireGzip = true;
    }
    const nextMeta: MetaJson = {
      ...meta,
      files: {
        ...meta.files,
        [key]: rowMeta,
      },
    };
    await this.pushMetaJson(workspaceId, nextMeta, ent.metaEtag, "pull-completion");
    file.localHash = hash;
    file.lastSync = new Date().toISOString();
    file.syncStatus = "ok";
    if (file.cloudPath !== downloadPath) {
      file.cloudPath = downloadPath;
    }
    await this.persistMutatedCfg(cfg);
    this.fireActivity({
      kind: "pull",
      workspaceId,
      workspaceNote: ent.workspaceNote,
      relPath: posixRel,
      machineName: this.deps.machineName,
      provider: this.deps.provider.type,
    });
    this.emitTransfer({ direction: "download", bytes: dl.body.length });
    return "updated";
    });
    });
  }

  /** Снимки в `.history/` для файла (новые первыми). */
  async listCloudHistoryForTrackedFile(posixRel: string): Promise<FileMetadata[]> {
    const cfg = await this.loadCfg();
    const hit = cfg.files.find((f) => f.localPath === posixRel);
    if (!hit) {
      throw new Error("not tracked");
    }
    const dir = historyDirForFile(hit.workspaceId, manifestKeyOf(hit));
    const items = await this.deps.provider.listFolder(dir);
    const baseName = (p: string): string => {
      const i = p.lastIndexOf("/");
      return i >= 0 ? p.slice(i + 1) : p;
    };
    return [...items].sort((a, b) => baseName(b.cloudPath).localeCompare(baseName(a.cloudPath)));
  }

  /**
   * Shared prologue of the tracked-blob readers: tracked row by local path,
   * its workspace entry, `_meta` row and wire codec — everything keyed by the
   * canonical manifest key (Link Bindings).
   */
  private async trackedReadContext(posixRel: string): Promise<{
    hit: TrackedFile;
    key: string;
    wireGzip: boolean;
  }> {
    const cfg = await this.loadCfg();
    const hit = cfg.files.find((f) => f.localPath === posixRel);
    if (!hit) {
      throw new Error("not tracked");
    }
    const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === hit.workspaceId);
    if (!ent) {
      throw new Error("no entry");
    }
    const meta = await this.pullMeta(hit.workspaceId, ent.metaEtag);
    const key = manifestKeyOf(hit);
    return { hit, key, wireGzip: meta.files[key]?.wireGzip === true };
  }

  /** Download with one retry on an empty 304 body (provider cache quirk). */
  private async downloadCloudBytes(cloudPath: string): Promise<Buffer> {
    let dl = await this.deps.provider.downloadFile(cloudPath, { signal: this.abortSignal });
    if (dl.notModified && dl.body.length === 0) {
      dl = await this.deps.provider.downloadFile(cloudPath, { signal: this.abortSignal });
    }
    return dl.body;
  }

  /** Скачать снимок истории, если путь принадлежит `.history/` этого файла. Декодируется decrypt + gunzip как у текущего файла по `_meta.wireGzip`. */
  async downloadHistorySnapshotIfOwned(posixRel: string, historyCloudPath: string): Promise<Buffer> {
    const { hit, key, wireGzip } = await this.trackedReadContext(posixRel);
    const prefix = `${historyDirForFile(hit.workspaceId, key)}/`;
    const norm = historyCloudPath.replace(/\/$/, "");
    if (!norm.startsWith(prefix)) {
      throw new Error("not a history path for this file");
    }
    return this.decodeCloudBlob(await this.downloadCloudBytes(norm), wireGzip);
  }

  /** Raw cloud bytes for tracked file decoded to canonical plaintext UTF-8 (decrypt + optional gunzip). */
  async downloadTrackedBlob(posixRel: string): Promise<{ body: Buffer }> {
    const { hit, key, wireGzip } = await this.trackedReadContext(posixRel);
    const path = blobCloudPath(hit.workspaceId, key, wireGzip);
    return { body: this.decodeCloudBlob(await this.downloadCloudBytes(path), wireGzip) };
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backup folders are named after the moment they were created. Second
 * resolution, not millisecond: at millisecond resolution every single pulled
 * file landed in a folder of its own, so a 500-file Pull All produced 500
 * folders and the retention set grew while the very pass that reads it was
 * still running.
 */
