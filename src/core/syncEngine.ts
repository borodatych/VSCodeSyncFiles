import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  WorkspaceConfig,
  TrackedFile,
  ActiveWorkspaceEntry,
  ManifestMachineCacheEntry,
  WorkspaceSyncState,
  ConflictRule,
} from "./types.js";
import { normalizeWorkspaceSyncState } from "./types.js";
import { WorkspaceConfigManager } from "./workspaceConfigManager.js";
import type { CloudManifest, ManifestFile, MetaJson, MachineEntry, MetaEntry } from "./cloudLayout.js";
import {
  CLOUD_ROOT_DIR,
  EMPTY_META_JSON,
  historyDirForFile,
  manifestCloudPath,
  metaCloudPath,
  SUPPORTED_MANIFEST_SCHEMA,
  sharedIgnorePatternsOrEmpty,
  trackedFileCloudPath,
  workspaceRootPath,
} from "./cloudLayout.js";
import { mergeCloudManifests, mergeMachinesPreferNewer, mergeManifestFiles } from "./manifestMerger.js";
import { copyCloudFileBetweenProviders } from "./cloudMigration.js";
import { createWorkspaceSnapshot } from "./snapshotsEngine.js";
import { planLocalBackupRetention } from "./localBackupRetentionPlan.js";
import { mergeMetaEntries } from "./metaMerge.js";
import { detectChange, type ChangeAction } from "./changeDetection.js";
import { parallelLimit } from "./parallelLimit.js";
import type { FileMetadata, ICloudProvider } from "../providers/cloudProviderTypes.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import type { LineEndingMode } from "../utils/normalize.js";
import {
  computeHash,
  hashCanonicalBuffer,
  hashCanonicalBufferDual,
  type HashConfig,
} from "../utils/hash.js";
import { verboseLog, warnLog } from "../utils/log.js";
import { validateManifestShape } from "./manifestValidate.js";
import { detectMassChange } from "./massChangeGuard.js";
import { preserveConflictSharesLfCanonical } from "./preserveLineEndingConflict.js";
import { mergeSyncignoreFromCloud, extractSyncignoreInners } from "../utils/syncignore.js";
import { normalizeIgnorePatternStrings } from "../utils/ignorePatternNormalize.js";
import { absoluteToTrackedPosix, trackedLocalAbsolutePath } from "./pathMapping.js";
import { isDeltaSyncEligible } from "./deltaSyncGate.js";
import { runWithSyncFileLock } from "./syncFileLock.js";
import {
  isPullMetaCloudWriteActive,
  isSecondaryWorkspaceInstanceReadOnly,
  rejectIfSecondaryWorkspaceInstanceReadOnly,
  withPullCloudMetaWriteAllowed,
} from "./syncWorkspaceInstanceReadOnly.js";
import type { ActivityEventInput } from "./activityLog.js";
import type { SyncTransferEvent } from "./syncStatsStore.js";
import {
  blobCloudPath,
  gunzipToPlaintext,
  gzipIfShrinks,
  plaintextLooksCompressible,
} from "./wireCompression.js";
import { fileLooksBinary } from "../utils/binaryDetect.js";
import { bufferLooksBinary } from "../utils/binary.js";

const HISTORY_VERSIONS_DEFAULT = 10;
const META_WRITE_RETRIES_DEFAULT = 3;
const VERIFY_RETRIES_DEFAULT = 3;
const TOMBSTONE_PURGE_DAYS_DEFAULT = 30;
const FILE_CONCURRENCY_DEFAULT = 1;
const WORKSPACE_CONCURRENCY_DEFAULT = 1;

/**
 * Minimal glob matcher for conflict rules.
 * Supports `*` (within one path segment) and `**` (any depth).
 */
function minimatchGlob(str: string, pattern: string): boolean {
  // Use  (private-use) as a safe sentinel for `**` so we can rewrite it
  // to `.*` after escaping `*` → `[^/]*` for single segments.
  const SENTINEL = "";
  const reStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, SENTINEL)
    .replace(/\*/g, "[^/]*")
    .replaceAll(SENTINEL, ".*");
  return new RegExp(`^${reStr}$`).test(str);
}

const LOCAL_BACKUP_DIR_DEFAULT = path.join(".vscode", "vscodesync-local-backup");

/** Soft lock (`ManifestFile.editingSince`) older than this is stale (Health Check / repair). */
export const STALE_MANIFEST_EDITING_LOCK_MS_DEFAULT = 3 * 3600_000;
/** Backwards-compat alias — engine callers can still read the default directly. */
export const STALE_MANIFEST_EDITING_LOCK_MS = STALE_MANIFEST_EDITING_LOCK_MS_DEFAULT;

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

export interface SyncEngineDeps {
  workspaceRoot: string;
  provider: ICloudProvider;
  machineId: string;
  machineName: string;
  /** Лимит размера одного файла (байт). Не задан или 0 — без лимита (тесты). */
  maxFileSizeBytes?: number;
  /** Нормализация строк при хэше; по умолчанию `lf` (тесты). */
  lineEnding?: LineEndingMode;
  /** Локальная копия перед перезаписью при pull. По умолчанию true. */
  localBackupEnabled?: boolean;
  /** Удалять каталоги бэкапов старше N дней (mtime). `0` — не чистить. По умолчанию 7. */
  localBackupRetentionDays?: number;
  /**
   * Optional E2E encryption applied after canonical pipeline and before upload.
   * The hash stored in `_meta` is always the PLAINTEXT canonical hash.
   */
  encrypt?: (buf: Buffer) => Buffer;
  /**
   * Optional E2E decryption applied after download and before writing locally.
   * Must be the inverse of `encrypt`.
   */
  decrypt?: (buf: Buffer) => Buffer;
  /** When `fileEncoding` is utf8 (default): BOM / invalid UTF-8 hints during hashing. */
  encodingLint?: boolean;
  onEncodingIssue?: (kind: "bom" | "invalid_utf8", trackedPosixRel: string) => void;
  /** When `lineEnding=preserve` and conflict is likely CRLF vs LF only (LF-canonical hashes match). */
  onPreserveLineEndingConflictHint?: (trackedPosixRel: string) => void;
  /** When true: new machines joining an existing workspace manifest get `pending` until approved on another machine. */
  requireMachineApproval?: () => boolean;
  /** Local activity log (Activity Feed); optional to keep tests and headless engines quiet. */
  onSyncActivity?: (ev: ActivityEventInput) => void;
  /** Bytes on the wire for tracked file upload/download (stats.json). */
  onTransfer?: (ev: SyncTransferEvent) => void;
  /** User setting: gzip text uploads when `_meta` records `wireGzip`. Default false. */
  compressUploads?: boolean;
  /**
   * Estimated plaintext bytes spared when gzip wire encoding is smaller than raw UTF-8 plaintext.
   */
  onCompressionSaving?: (plaintextBytesSaved: number) => void;
  /**
   * §8.2 Delta sync (roadmap): when true and file size ≥ threshold, rolling-hash path will apply (not implemented yet — full upload).
   */
  deltaSync?: boolean;
  /** Minimum plaintext size in KB for delta consideration. Default 100. */
  deltaThresholdKB?: number;
  /**
   * Ordered list of auto-conflict-resolution rules. Checked before showing conflict to user.
   * First matching rule wins. Strategies: keep-mine (push local), take-theirs (pull cloud), newer (compare updatedAt).
   */
  conflictRules?: ConflictRule[];
  /** Days after which tombstone entries (removedAt) are purged from the manifest on next PUT. Default 30. */
  tombstonePurgeDays?: number;
  /**
   * Called when a locally-tracked file disappears from the cloud manifest (tombstone purged after 30+ days offline).
   * The local file still exists on disk but is no longer tracked. UI should warn the user.
   */
  onPurgeLostFiles?: (items: PurgeLostFileItem[]) => void;
  /**
   * Called when a new conflict is detected for a file.
   * `isBinary` = true when the file looks binary (no-null-bytes heuristic failed = has null bytes).
   * UI layer should surface a notification / quick-pick.
   */
  onNewConflict?: (workspaceId: string, workspaceNote: string, relPath: string, isBinary: boolean) => void;
  /**
   * Called when an already-connected workspace manifest has a higher schemaVersion
   * than this extension supports (future-compat: user needs to update extension).
   * UI layer should warn the user and skip sync for that workspace.
   */
  onSchemaVersionTooNew?: (workspaceId: string, detectedVersion: number) => void;
  /**
   * Called when the cloud manifest fails JSON / shape validation.
   * UI layer offers Repair State (rebuild from local).
   */
  onCorruptManifest?: (workspaceId: string, reason: string) => void;
  /**
   * v0.17 D02 — fired when an upload returns `STORAGE_QUOTA_EXCEEDED`.
   * The UI layer surfaces the quota banner with `planQuotaExhaustion` +
   * top-N heaviest files. Default behaviour (callback absent): the
   * error propagates as-is.
   */
  onQuotaExhausted?: (workspaceId: string, posixRel: string, providerLabel: string) => void;
  /**
   * Called when a locally-attached workspace is detected as deleted on the cloud by another machine
   * (manifest NOT_FOUND). The workspace is auto-detached locally before this callback fires.
   * UI layer should notify the user and optionally offer to re-upload via `repushWorkspaceToCloud`.
   */
  onRemoteWorkspaceDeleted?: (
    workspaceId: string,
    workspaceNote: string,
    workspaceRoot: string,
    savedEntry: ActiveWorkspaceEntry,
    savedFiles: TrackedFile[],
  ) => void;
  /**
   * Called after a file is successfully written to disk during pull.
   * Provides old and new UTF-8 content for diff/notification purposes.
   * `oldContent` is null when the file did not exist locally before pull.
   */
  onFilePulled?: (posixRel: string, oldContent: string | null, newContent: string) => void;
  /**
   * Called before `putManifest` writes a manifest that would tombstone a large
   * batch of files (see `detectMassChange`). UI layer surfaces a confirmation
   * modal. Resolve `true` to proceed, `false` to abort the manifest write.
   * If undefined, the guard is disabled and putManifest proceeds unconditionally.
   */
  onMassChange?: (
    workspaceId: string,
    report: import("./massChangeGuard.js").MassChangeReport,
  ) => Promise<boolean>;
  /**
   * Returns the current `vscodesync.canonicalHashAlgo` setting. When the
   * caller resolves `"blake3"` or `"dual"`, `pushFile` writes both `hash`
   * (SHA-256, wire-compat) and `hashBlake3` into the meta entry. Default
   * `"sha256"` keeps legacy behaviour (no BLAKE3 column).
   */
  canonicalHashAlgo?: () => "sha256" | "blake3" | "dual";
  /**
   * v2.1.4 — opt-in P2P file-transfer hook. Called after a successful
   * `pushFile` upload completes (cloud authoritative). The P2P UI runtime
   * can mirror the same plaintext buffer to peers via WebRTC DataChannel
   * — no canonicalisation needed (cloud upload already used the canonical
   * form). Errors thrown by the hook are swallowed by the engine; the
   * push itself has already succeeded.
   */
  onPushFile?: (
    workspaceId: string,
    posixRel: string,
    plaintext: Buffer,
    meta: { hash: string; hashBlake3?: string; version: number },
  ) => void;
  /**
   * v0.18 W3 — fired by `attachCloudWorkspace` when the cloud manifest
   * has a `schemaVersion` we don't natively support. UI returns
   * `"migrate"` to attempt a coordinated migration (caller schedules it),
   * `"abort"` to cancel the attach. When the callback is absent the
   * engine behaves as before — throws on mismatch.
   */
  onSchemaVersionMismatch?: (
    workspaceId: string,
    detectedVersion: number,
    supportedVersion: number,
  ) => Promise<"migrate" | "abort">;
  /**
   * v0.18 D01 — opt-in provider-side hash verification. When `true` and
   * the provider exposes a digest via `getMetadata` (gdrive md5, yandex
   * md5, dropbox content_hash, onedrive sha256), we compute the expected
   * digest locally and abort the push on mismatch.
   *
   * Default `false` so existing users see no behaviour change; opt in
   * via `vscodesync.providerHashVerify` setting.
   */
  providerHashVerify?: () => boolean;
  /**
   * v0.18 D06 — opt-in trust check. When set, `requireMachineApproval`
   * flow skips approval gate for machineIds the user has marked as
   * trusted. Default (no callback): legacy behaviour — every new machine
   * is `pending` until manually approved on another machine.
   */
  isTrustedTeammate?: (machineId: string) => boolean;
  /**
   * v0.7 — bounded concurrency for the per-workspace file iteration
   * (syncWorkspace / forcePullWorkspace / pushAll inner loop). Returns the
   * desired concurrency cap (1 = legacy serial). Setting via
   * `vscodesync.sync.concurrency`. Resolver-shaped so the engine picks up
   * live setting changes without rebuild.
   */
  syncFileConcurrency?: () => number;
  /**
   * v0.7 — bounded concurrency for the outer iteration across workspaces
   * inside one workspace folder (pushAll / pullAll). 1 = legacy serial.
   * Setting via `vscodesync.sync.workspaceConcurrency`.
   */
  syncWorkspaceConcurrency?: () => number;
  /**
   * v0.7 — verification mode for `pushFile`. After upload, the engine may
   * download the blob again and re-hash it against the local plaintext hash
   * to catch wire corruption. Default `"plaintext-only"` preserves the
   * historical behaviour (verify only when bytes hit the cloud unencrypted).
   * `"never"` skips the post-upload GET entirely — fastest, leans on
   * provider ETag / managed integrity instead.
   */
  verifyUploadHash?: () => "plaintext-only" | "never";
  /** v0.7 — overrides `HISTORY_VERSIONS_DEFAULT` (10). Setting via `vscodesync.historyVersions`. */
  historyVersions?: () => number;
  /** v0.7 — overrides `META_WRITE_RETRIES_DEFAULT` (3). Setting via `vscodesync.metaWriteRetries`. */
  metaWriteRetries?: () => number;
  /** v0.7 — overrides `VERIFY_RETRIES_DEFAULT` (3). Setting via `vscodesync.verifyRetries`. */
  verifyRetries?: () => number;
  /** v0.7 — overrides `STALE_MANIFEST_EDITING_LOCK_MS_DEFAULT` (3h). Setting via `vscodesync.softLockStaleHours`. */
  softLockStaleMs?: () => number;
  /** v0.7 — local backup dir under workspace root. Default `.vscode/vscodesync-local-backup`. Setting via `vscodesync.localBackupDir`. */
  localBackupDir?: () => string;
  /**
   * v0.7 — when `inline`, snapshot the old blob into `.history/` synchronously
   * before each push (legacy). When `lazy`, queue snapshots in memory and let
   * the host flush them periodically via `drainLazyHistoryQueue`. When `off`,
   * skip history entirely. Setting via `vscodesync.historyMode`.
   */
  historyMode?: () => "inline" | "lazy" | "off";
  /**
   * v0.7 — drain hook for the lazy history queue. Host calls this on a
   * timer; engine returns the queued (workspaceId, posixRel, oldCloudPath)
   * triples and clears its in-memory queue. Pure side-effect-free read.
   */
  onLazyHistoryQueued?: (entry: LazyHistoryEntry) => void;
  /**
   * v0.7 — opt-in profiler hook. When set, the engine emits per-file timing
   * samples (hash ms, upload ms, verify ms, full round-trip ms) so the UI
   * can render a "slow files" diagnostic. Setting via
   * `vscodesync.diagnostics.profileSync`.
   */
  onSyncProfileSample?: (sample: SyncProfileSample) => void;
}

/** v0.7 — deferred history snapshot. */
export interface LazyHistoryEntry {
  workspaceId: string;
  posixRel: string;
  oldCloudPath: string;
  /** ms — when the snapshot was queued (so drain can age-out stale entries). */
  queuedAtMs: number;
}

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
  private readonly manifestByWs = new Map<string, CloudManifest>();
  private readonly metaByWs = new Map<string, MetaJson>();
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
  private readonly lazyHistoryQueue: LazyHistoryEntry[] = [];
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

  private inFlightKey(workspaceId: string, posixRel: string): string {
    return `${workspaceId} ${posixRel}`;
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
    if (this.lazyHistoryQueue.length === 0) return [];
    const drained = this.lazyHistoryQueue.splice(0, this.lazyHistoryQueue.length);
    return drained;
  }

  /** v0.7 — execute queued history snapshots from a prior drain. */
  async runDeferredHistorySnapshots(entries: readonly LazyHistoryEntry[]): Promise<void> {
    for (const e of entries) {
      try {
        await this.snapshotHistoryNow(e.workspaceId, e.posixRel, e.oldCloudPath);
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
      throw new Error("Workspace в режиме Suspend: загрузка и выгрузка файлов отключены.");
    }
    if (st === "frozen") {
      throw new Error("Workspace заморожен (Freeze): операции с файлами отключены.");
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
      throw new Error(
        "Workspace: эта машина ожидает подтверждения в манифесте — отправка и изменение состава файлов отключены (выполните Pull или дождитесь одобрения на другой машине).",
      );
    }
    if (st === "blocked") {
      throw new Error("Workspace: машина заблокирована в манифесте — запись отключена.");
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
    const baseCfg = this.hashCfg(file.localPath);
    if (!preserveConflictSharesLfCanonical(localBuf, cloudBuf, file.localPath, baseCfg)) {
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
    if (!preserveConflictSharesLfCanonical(localBuf, cloudBuf, file.localPath, this.hashCfg(file.localPath))) {
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
  private static directChildFolderIds(cloudRoot: string, items: FileMetadata[]): string[] {
    const base = cloudRoot.endsWith("/") ? cloudRoot : `${cloudRoot}/`;
    const ids = new Set<string>();
    for (const it of items) {
      let rest: string | undefined;
      if (it.cloudPath.startsWith(base)) {
        rest = it.cloudPath.slice(base.length);
      } else {
        // app folder: Yandex returns full disk path, e.g. "Приложения/App/VSCodeSyncFiles/id"
        const markerIdx = it.cloudPath.indexOf(base);
        if (markerIdx >= 0) {
          rest = it.cloudPath.slice(markerIdx + base.length);
        }
      }
      if (rest === undefined) {
        continue;
      }
      const seg = rest.split("/")[0];
      if (!seg || seg.includes(".")) {
        continue;
      }
      ids.add(seg);
    }
    return [...ids];
  }

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
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const root = workspaceRootPath(workspaceId);
    const listed = await this.deps.provider.listFolder(root);

    // Filter to actual blob files (exclude manifest, meta, history, snapshots, gz variants tracked separately)
    const SKIP_PREFIXES = [
      `${root}/.history/`,
      `${root}/.snapshots/`,
    ];
    const SKIP_NAMES = [
      ".vscodesync-workspace.json",
      "_meta.json",
    ];

    const blobs = listed.filter((item) => {
      const name = item.cloudPath.slice(root.length + 1); // relative to workspace root
      if (SKIP_NAMES.includes(name)) return false;
      if (SKIP_PREFIXES.some((pfx) => item.cloudPath.startsWith(pfx))) return false;
      return true;
    });

    // Strip .gz suffix for wire-compressed blobs
    const paths = blobs.map((b) => {
      let p = b.cloudPath.slice(root.length + 1);
      if (p.endsWith(".gz")) {
        p = p.slice(0, -3);
      }
      return p;
    });

    if (paths.length === 0) {
      return [];
    }

    // Reconstruct a minimal _meta.json with placeholders
    const now = new Date().toISOString();
    const metaFiles: MetaJson["files"] = {};
    for (const p of paths) {
      metaFiles[p] = {
        hash: "",
        etag: "",
        version: 0,
        updatedAt: now,
        machineId: this.deps.machineId,
        wireGzip: blobs.some((b) => b.cloudPath === `${root}/${p}.gz`),
      };
    }
    const reconstructedMeta: MetaJson = { files: metaFiles };

    // Write reconstructed _meta.json to cloud
    await this.deps.provider.uploadFile(
      metaCloudPath(workspaceId),
      Buffer.from(`${JSON.stringify(reconstructedMeta, null, 2)}\n`, "utf8"),
    );
    this.metaByWs.set(workspaceId, reconstructedMeta);

    // Update local config to record that this workspace has been scanned
    const cfg = await this.loadCfg();
    const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === workspaceId);
    if (ix >= 0) {
      cfg.activeWorkspaces[ix] = { ...cfg.activeWorkspaces[ix] };
      await this.saveCfg(cfg);
    }

    return paths;
  }

  async listRemoteWorkspaceSummaries(): Promise<{ workspaceId: string; workspaceNote: string }[]> {
    const listed = await this.deps.provider.listFolder(CLOUD_ROOT_DIR);
    const candidates = SyncEngine.directChildFolderIds(CLOUD_ROOT_DIR, listed);
    const out: { workspaceId: string; workspaceNote: string }[] = [];
    for (const id of candidates) {
      try {
        const dl = await this.deps.provider.downloadFile(manifestCloudPath(id));
        const m = JSON.parse(dl.body.toString("utf8")) as {
          schemaVersion?: number;
          workspaceId?: string;
          workspaceNote?: string;
        };
        if (m.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
          continue;
        }
        if (m.workspaceId !== id) {
          continue;
        }
        out.push({ workspaceId: id, workspaceNote: m.workspaceNote ?? id });
      } catch {
        /* не workspace */
      }
    }
    out.sort((a, b) => a.workspaceNote.localeCompare(b.workspaceNote, undefined, { sensitivity: "base" }));
    return out;
  }

  /**
   * Подключить workspace с облака: локальный `activeWorkspaces`, регистрация машины в манифесте,
   * трекинг файлов из манифеста и sync (pull при необходимости).
   */
  async attachCloudWorkspace(workspaceId: string): Promise<void> {
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
      manifestMachines: this.manifestMachineCache(manifest),
      manifestEtag: manifestDl.etag,
      metaEtag,
    });
    await this.saveCfg(cfg0);
    this.manifestByWs.set(workspaceId, manifest);
    this.metaByWs.set(workspaceId, meta);

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
    let changed = false;
    for (const mf of manifest.files.filter((f) => !f.removedAt)) {
      const posixRel = mf.path;
      if (cfg.files.some((f) => f.workspaceId === workspaceId && f.localPath === posixRel)) {
        continue;
      }
      // Detect rename: if manifest says this file was renamed from another path,
      // update the existing entry instead of registering a duplicate.
      if (mf.renamedFrom) {
        const oldIdx = cfg.files.findIndex(
          (f) => f.workspaceId === workspaceId && f.localPath === mf.renamedFrom,
        );
        if (oldIdx >= 0) {
          cfg.files[oldIdx] = {
            ...cfg.files[oldIdx],
            localPath: posixRel,
            cloudPath: trackedFileCloudPath(workspaceId, posixRel),
            localHash: meta.files[posixRel]?.hash ?? "",
          };
          changed = true;
          continue;
        }
      }
      cfg.files.push({
        localPath: posixRel,
        workspaceId,
        cloudPath: trackedFileCloudPath(workspaceId, posixRel),
        lastSync: stamp,
        localHash: meta.files[posixRel]?.hash ?? "",
        syncStatus: "ok",
      });
      changed = true;
    }
    if (changed) {
      await this.saveCfg(cfg);
    }
  }

  private async loadCfg(): Promise<WorkspaceConfig> {
    return WorkspaceConfigManager.load(this.deps.workspaceRoot);
  }

  private async saveCfg(c: WorkspaceConfig): Promise<void> {
    return WorkspaceConfigManager.save(c, this.deps.workspaceRoot);
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
    const cfg = await this.loadCfg();
    const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === workspaceId);
    if (ix < 0) {
      throw new Error(`active workspace not found: ${workspaceId}`);
    }
    cfg.activeWorkspaces[ix] = { ...cfg.activeWorkspaces[ix], ...patch };
    await this.saveCfg(cfg);
  }

  private findTracked(cfg: WorkspaceConfig, workspaceId: string, posixRel: string): TrackedFile | undefined {
    return cfg.files.find((f) => f.workspaceId === workspaceId && f.localPath === posixRel);
  }

  async createWorkspace(workspaceNote: string, providerType: CloudManifest["providerType"]): Promise<string> {
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
      manifestMachines: this.manifestMachineCache(manifest),
      manifestEtag: up.etag,
      metaEtag: metaUp.etag,
    });
    await this.saveCfg(cfg);
    this.manifestByWs.set(workspaceId, manifest);
    return workspaceId;
  }

  /** Только локально: убрать workspace и его трекинг (облако не изменяется). */
  async detachWorkspaceLocal(workspaceId: string): Promise<void> {
    const cfg = await this.loadCfg();
    const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === workspaceId);
    if (ix < 0) {
      throw new Error("workspace не подключён к этому проекту");
    }
    cfg.activeWorkspaces.splice(ix, 1);
    cfg.files = cfg.files.filter((f) => f.workspaceId !== workspaceId);
    await this.saveCfg(cfg);
    this.manifestByWs.delete(workspaceId);
    this.metaByWs.delete(workspaceId);
  }

  /**
   * Deletes every blob under `VSCodeSyncFiles/{workspaceId}/`, then detaches this workspace locally.
   * Ignores Suspend/Freeze — destructive op.
   */
  async deleteWorkspaceFromCloud(workspaceId: string): Promise<void> {
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg = await this.loadCfg();
    if (!cfg.activeWorkspaces.some((w) => w.workspaceId === workspaceId)) {
      throw new Error("workspace не подключён к этому проекту");
    }
    await this.deleteCloudFilesOnly(workspaceId);
    await this.detachWorkspaceLocal(workspaceId);
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
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.deleteCloudFolderRecursive(workspaceRootPath(workspaceId));
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
  private async deleteCloudFolderRecursive(folderPath: string): Promise<void> {
    const asDir = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
    let items: FileMetadata[];
    try {
      items = await this.deps.provider.listFolder(asDir);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        return;
      }
      throw e;
    }
    for (const it of items) {
      const p = it.cloudPath;
      const childPrefix = p.endsWith("/") ? p : `${p}/`;
      let nested: FileMetadata[];
      try {
        nested = await this.deps.provider.listFolder(childPrefix);
      } catch (e) {
        if (e instanceof ProviderError && e.code === "NOT_FOUND") {
          nested = [];
        } else {
          throw e;
        }
      }
      if (nested.length > 0) {
        await this.deleteCloudFolderRecursive(p);
      }
      try {
        await this.deps.provider.deleteFile(p);
      } catch (e) {
        if (!(e instanceof ProviderError && e.code === "NOT_FOUND")) {
          throw e;
        }
      }
    }
  }

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

    this.manifestByWs.delete(sourceWorkspaceId);
    this.manifestByWs.delete(targetWorkspaceId);
    this.metaByWs.delete(sourceWorkspaceId);
    this.metaByWs.delete(targetWorkspaceId);

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
    await createWorkspaceSnapshot(
      this.deps.provider,
      this.deps.workspaceRoot,
      sourceWorkspaceId,
      snapHint,
      this.deps.machineName,
    );
    await createWorkspaceSnapshot(
      this.deps.provider,
      this.deps.workspaceRoot,
      targetWorkspaceId,
      snapHint,
      this.deps.machineName,
    );

    const sortedPaths = [...srcPaths].sort((a, b) => a.localeCompare(b));
    for (const posixRel of sortedPaths) {
      const srcCloud = trackedFileCloudPath(sourceWorkspaceId, posixRel);
      const dstCloud = trackedFileCloudPath(targetWorkspaceId, posixRel);
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
    await this.pushMetaJson(targetWorkspaceId, mergedMeta, entTgt3.metaEtag);

    if (!deleteSourceWorkspace) {
      await this.evacuateMergedSourceWorkspace(sourceWorkspaceId, srcManifestFull);
    }

    await this.mergeLocalTrackedAfterWorkspaceMerge(sourceWorkspaceId, targetWorkspaceId);

    if (deleteSourceWorkspace) {
      await this.deleteCloudFolderRecursive(workspaceRootPath(sourceWorkspaceId));
    }

    this.manifestByWs.delete(sourceWorkspaceId);
    this.metaByWs.delete(sourceWorkspaceId);

    cfgInit = await this.loadCfg();
    const tgtEntryPost = cfgInit.activeWorkspaces.find((w) => w.workspaceId === targetWorkspaceId);
    this.manifestByWs.delete(targetWorkspaceId);
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
    for (const mf of priorManifest.files.filter((f) => !f.removedAt)) {
      try {
        await this.deps.provider.deleteFile(trackedFileCloudPath(sourceWorkspaceId, mf.path));
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
    await this.pushMetaJson(sourceWorkspaceId, EMPTY_META_JSON, entAfter.metaEtag);
  }

  /**
   * Перевести треки источника на цель, объединить кэши тегов; убрать источник из activeWorkspaces (если ещё не убран).
   */
  private async mergeLocalTrackedAfterWorkspaceMerge(sourceId: string, targetId: string): Promise<void> {
    const cfg = await this.loadCfg();
    const srcEnt = cfg.activeWorkspaces.find((w) => w.workspaceId === sourceId);
    const tgtEnt = cfg.activeWorkspaces.find((w) => w.workspaceId === targetId);
    if (!tgtEnt) {
      throw new Error("цель merge не найдена в активных workspace после облака");
    }
    const tagUnion = [...new Set([...(tgtEnt.tags ?? []), ...(srcEnt?.tags ?? [])])];

    cfg.files = cfg.files.map((f) => {
      if (f.workspaceId !== sourceId) {
        return f;
      }
      return {
        ...f,
        workspaceId: targetId,
        cloudPath: trackedFileCloudPath(targetId, f.localPath),
      };
    });
    cfg.activeWorkspaces = cfg.activeWorkspaces.filter((w) => w.workspaceId !== sourceId);

    const ti = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === targetId);
    if (ti >= 0 && tagUnion.length > 0) {
      cfg.activeWorkspaces[ti] = { ...cfg.activeWorkspaces[ti], tags: tagUnion };
    }

    await this.saveCfg(cfg);
  }

  /** Обновить название workspace в облачном манифесте и в `vscodesync.json`. */
  async renameWorkspaceNote(workspaceId: string, newNote: string): Promise<void> {
    const note = newNote.trim();
    if (!note) {
      throw new Error("Название не может быть пустым");
    }
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
    const updated: CloudManifest = {
      ...remote,
      workspaceNote: note,
      updatedAt: now,
      machines: this.touchMachine(remote.machines, now),
    };
    await this.putManifest(workspaceId, updated, entry.manifestEtag);
    await this.patchEntry(workspaceId, { workspaceNote: note, manifestMachines: this.manifestMachineCache(updated) });
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
    const branch = gitBranchRaw.trim();
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
    const updated: CloudManifest = {
      ...remote,
      gitBranch: branch === "" ? undefined : branch,
      updatedAt: now,
      machines: this.touchMachine(remote.machines, now),
    };
    await this.putManifest(workspaceId, updated, entry.manifestEtag);
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

  async setWorkspaceTags(workspaceId: string, tags: string[]): Promise<void> {
    const normalized = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))];
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
    const updated: CloudManifest = {
      ...remote,
      tags: normalized,
      updatedAt: now,
      machines: this.touchMachine(remote.machines, now),
    };
    await this.putManifest(workspaceId, updated, entry.manifestEtag);
    await this.patchEntry(workspaceId, { tags: normalized });
  }

  async setWorkspaceSharedIgnorePatterns(workspaceId: string, patterns: string[]): Promise<void> {
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const normalized = normalizeIgnorePatternStrings(patterns);
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
    const updated: CloudManifest = {
      ...remote,
      sharedIgnorePatterns: normalized,
      updatedAt: now,
      machines: this.touchMachine(remote.machines, now),
    };
    await this.putManifest(workspaceId, updated, entry.manifestEtag);
    await this.patchEntry(workspaceId, { sharedIgnorePatterns: normalized });
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
    const now = Date.now();
    const out: { path: string; editingBy: string; editingSince: string; ageHours: number }[] = [];
    for (const f of m.files) {
      if (f.removedAt) {
        continue;
      }
      if (!f.editingBy || !f.editingSince) {
        continue;
      }
      const t = Date.parse(f.editingSince);
      if (Number.isNaN(t) || now - t < this.resolveSoftLockStaleMs()) {
        continue;
      }
      out.push({
        path: f.path,
        editingBy: f.editingBy,
        editingSince: f.editingSince,
        ageHours: (now - t) / 3600_000,
      });
    }
    return out;
  }

  /**
   * Clear soft locks on manifest files when `editingSince` is older than `STALE_MANIFEST_EDITING_LOCK_MS`.
   * @returns Number of files updated.
   */
  async clearStaleManifestEditingLocks(workspaceId: string): Promise<number> {
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
    const now = Date.now();
    let cleared = 0;
    const files: ManifestFile[] = m.files.map((f) => {
      if (!f.editingBy || !f.editingSince) {
        return f;
      }
      const t = Date.parse(f.editingSince);
      if (Number.isNaN(t) || now - t < this.resolveSoftLockStaleMs()) {
        return f;
      }
      cleared += 1;
      const rest = { ...f };
      delete rest.editingBy;
      delete rest.editingSince;
      return { ...rest, version: f.version + 1 };
    });
    if (cleared === 0) {
      return 0;
    }
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
    const now = new Date().toISOString();
    const mfIx = m.files.findIndex((f) => f.path === posixRel && !f.removedAt);
    if (mfIx < 0) {
      return;
    }
    // Already locked by this machine — just update editingSince (heartbeat)
    const updated: CloudManifest = {
      ...m,
      updatedAt: now,
      machines: this.touchMachine(m.machines, now),
      files: m.files.map((f, i) =>
        i === mfIx
          ? { ...f, editingBy: this.deps.machineId, editingSince: now, version: f.version + 1 }
          : f,
      ),
    };
    try {
      await this.putManifest(workspaceId, updated, entry.manifestEtag);
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
    const mfIx = m.files.findIndex((f) => f.path === posixRel && !f.removedAt);
    if (mfIx < 0) {
      return;
    }
    const existing = m.files[mfIx];
    if (!existing.editingBy || existing.editingBy !== this.deps.machineId) {
      return; // Only clear own lock
    }
    const now = new Date().toISOString();
    const { editingBy: _editingBy, editingSince: _editingSince, ...rest } = existing;
    const updated: CloudManifest = {
      ...m,
      updatedAt: now,
      machines: this.touchMachine(m.machines, now),
      files: m.files.map((f, i) =>
        i === mfIx ? { ...rest, version: f.version + 1 } : f,
      ),
    };
    try {
      await this.putManifest(workspaceId, updated, entry.manifestEtag);
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
      this.manifestByWs.set(id, manifest);
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
      this.metaByWs.set(id, meta);
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
        manifestMachines: this.manifestMachineCache(manifest),
      };
    }
    await this.saveCfg(cfg);
  }

  async addFiles(workspaceId: string, absolutePaths: string[]): Promise<void> {
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
      await this.assertFileWithinSizeLimit(abs);
      const posixRel = this.posixRel(cfg, abs);
      const cloudPath = trackedFileCloudPath(workspaceId, posixRel);
      const markers = await this.fileHasSyncMarkers(abs);
      const exists = localCopy.files.some((f) => f.path === posixRel && !f.removedAt);
      if (!exists) {
        localCopy.files.push({
          path: posixRel,
          addedAt: now,
          version: this.nextManifestVersion(localCopy.files),
          hasSyncignoreMarkers: markers,
        });
      }
      await this.pushBlobRaw(cloudPath, abs);
      const hash = await computeHash(abs, this.hashCfg(posixRel));
      const dl = await this.deps.provider.downloadFile(cloudPath);
      const prev = meta.files[posixRel];
      const prevVersion = prev === undefined ? 0 : prev.version;
      meta.files[posixRel] = {
        hash,
        etag: dl.etag ?? "",
        version: prevVersion + 1,
        machineId: this.deps.machineId,
        updatedAt: new Date().toISOString(),
      };
      this.metaByWs.set(workspaceId, meta);
      const tracked: TrackedFile = {
        localPath: posixRel,
        workspaceId,
        cloudPath,
        lastSync: now,
        localHash: hash,
        syncStatus: "ok",
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
    await this.pushMetaJson(workspaceId, meta, entDisk.metaEtag);
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

  /** Удалить файлы из трекинга: blob в облаке, строка в `_meta`, tombstone в манифесте, запись в локальном кэше. */
  async removeTrackedFiles(workspaceId: string, absolutePaths: string[]): Promise<void> {
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
      const tracked = this.findTracked(cfg, workspaceId, posixRel);
      const cloudPath = tracked?.cloudPath ?? trackedFileCloudPath(workspaceId, posixRel);

      try {
        await this.deps.provider.deleteFile(cloudPath);
      } catch (e) {
        if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
          throw e;
        }
      }
      meta.files = Object.fromEntries(
        Object.entries(meta.files).filter(([key]) => key !== posixRel),
      );

      const mfIx = localCopy.files.findIndex((f) => f.path === posixRel);
      const nextVer = this.nextManifestVersion(localCopy.files);
      if (mfIx >= 0) {
        const prev = localCopy.files[mfIx];
        localCopy.files[mfIx] = {
          ...prev,
          removedAt: now,
          version: Math.max(nextVer, prev.version + 1),
        };
      } else {
        localCopy.files.push({
          path: posixRel,
          addedAt: now,
          version: nextVer,
          hasSyncignoreMarkers: false,
          removedAt: now,
        });
      }
      this.fireActivity({
        kind: "remove",
        workspaceId,
        workspaceNote: entry.workspaceNote,
        relPath: posixRel,
        machineName: this.deps.machineName,
        provider: this.deps.provider.type,
      });
    }

    const relSet = new Set(absolutePaths.map((a) => this.posixRel(cfg, a)));
    cfg.files = cfg.files.filter((f) => !(f.workspaceId === workspaceId && relSet.has(f.localPath)));

    let diskCfg = await this.loadCfg();
    const entDisk = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entDisk) {
      throw new Error("workspace entry lost");
    }
    await this.pushMetaJson(workspaceId, meta, entDisk.metaEtag);
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
      meta.files = Object.fromEntries(
        Object.entries(meta.files).filter(([key]) => key !== posixRel),
      );
      const mfIx = localCopy.files.findIndex((f) => f.path === posixRel);
      const nextVer = this.nextManifestVersion(localCopy.files);
      if (mfIx >= 0) {
        const prev = localCopy.files[mfIx];
        localCopy.files[mfIx] = {
          ...prev,
          removedAt: now,
          version: Math.max(nextVer, prev.version + 1),
        };
      } else {
        localCopy.files.push({
          path: posixRel,
          addedAt: now,
          version: nextVer,
          hasSyncignoreMarkers: false,
          removedAt: now,
        });
      }
    }

    const relSet = new Set(absolutePaths.map((a) => this.posixRel(cfg, a)));
    cfg.files = cfg.files.filter((f) => !(f.workspaceId === workspaceId && relSet.has(f.localPath)));

    let diskCfg = await this.loadCfg();
    const entDisk = diskCfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entDisk) {
      throw new Error("workspace entry lost");
    }
    await this.pushMetaJson(workspaceId, meta, entDisk.metaEtag);
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
    const meta = await this.pullMeta(workspaceId, entry.metaEtag);

    const oldCloudPath = trackedEntry.cloudPath;
    const newCloudPath = trackedFileCloudPath(workspaceId, newRel);

    // Copy blob: download old, upload to new path
    try {
      const dl = await this.deps.provider.downloadFile(oldCloudPath);
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
    // Add new entry with renamedFrom marker
    const existingNewIx = localCopy.files.findIndex((f) => f.path === newRel);
    const newManifestFile: ManifestFile = {
      path: newRel,
      addedAt: now,
      version: this.nextManifestVersion(localCopy.files),
      hasSyncignoreMarkers: trackedEntry.syncStatus === "ok" ? false : trackedEntry.syncStatus === "conflict",
      renamedFrom: oldRel,
      renamedAt: now,
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
    await this.pushMetaJson(workspaceId, meta, entDisk.metaEtag);
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

  private touchMachine(machines: CloudManifest["machines"], now: string): CloudManifest["machines"] {
    const byId = new Map(machines.map((m) => [m.machineId, { ...m }]));
    const cur = byId.get(this.deps.machineId);
    const requireApproval = this.deps.requireMachineApproval?.() === true;
    if (cur) {
      cur.lastSeen = now;
    } else {
      const othersBeforeSelf = byId.size;
      const initialStatus: "pending" | "active" =
        requireApproval && othersBeforeSelf > 0 ? "pending" : "active";
      byId.set(this.deps.machineId, {
        machineId: this.deps.machineId,
        machineName: this.deps.machineName,
        lastSeen: now,
        status: initialStatus,
      });
    }
    return [...byId.values()];
  }

  private manifestMachineCache(m: CloudManifest): ManifestMachineCacheEntry[] {
    return m.machines.map((x) => ({
      machineId: x.machineId,
      machineName: x.machineName,
      lastSeen: x.lastSeen,
      status: x.status,
    }));
  }

  private entryPatchFromManifest(m: CloudManifest): Pick<
    ActiveWorkspaceEntry,
    "tags" | "gitBranch" | "sharedIgnorePatterns" | "manifestMachines"
  > {
    return {
      tags: m.tags,
      gitBranch: m.gitBranch,
      sharedIgnorePatterns: sharedIgnorePatternsOrEmpty(m),
      manifestMachines: this.manifestMachineCache(m),
    };
  }

  private async downloadManifest(
    workspaceId: string,
    ifNoneMatch: string | undefined,
  ): Promise<CloudManifest | null> {
    let dl: Awaited<ReturnType<typeof this.deps.provider.downloadFile>>;
    try {
      dl = await this.deps.provider.downloadFile(manifestCloudPath(workspaceId), {
        ifNoneMatch,
      });
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        return null;
      }
      throw e;
    }
    if (dl.notModified) {
      const cached = this.manifestByWs.get(workspaceId);
      if (cached) {
        return cached;
      }
      const full = await this.deps.provider.downloadFile(manifestCloudPath(workspaceId));
      const m = this.parseManifestSafe(workspaceId, full.body);
      if (!m) return null;
      this.manifestByWs.set(workspaceId, m);
      if (full.etag) {
        await this.patchEntry(workspaceId, {
          manifestEtag: full.etag,
          ...this.entryPatchFromManifest(m),
        });
      }
      return m;
    }
    const m = this.parseManifestSafe(workspaceId, dl.body);
    if (!m) return null;
    this.manifestByWs.set(workspaceId, m);
    if (dl.etag) {
      await this.patchEntry(workspaceId, {
        manifestEtag: dl.etag,
        ...this.entryPatchFromManifest(m),
      });
    }
    return m;
  }

  /**
   * Parse a cloud manifest body. On JSON / shape errors notifies the host and
   * returns `null` so callers fall through to the «manifest gone» recovery
   * path — which will surface to the user (auto-detach or rebuild).
   */
  private parseManifestSafe(workspaceId: string, body: Buffer): CloudManifest | null {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as CloudManifest;
      if (!parsed.workspaceId || !Array.isArray(parsed.files)) {
        throw new Error("manifest schema mismatch");
      }
      return parsed;
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      warnLog("syncEngine", `manifest corrupt for ${workspaceId}: ${reason}`);
      this.deps.onCorruptManifest?.(workspaceId, reason);
      return null;
    }
  }

  /** Manifest was deleted from cloud while workspace still exists locally — rebuild from tracked files and re-upload. */
  private async rebuildManifestFromLocalState(
    workspaceId: string,
    cfg: WorkspaceConfig,
    entry: ActiveWorkspaceEntry,
  ): Promise<void> {
    const now = new Date().toISOString();
    const trackedPaths = cfg.files
      .filter((f) => f.workspaceId === workspaceId)
      .map((f) => f.localPath);
    const manifestFiles: ManifestFile[] = trackedPaths.map((p, i) => ({
      path: p,
      addedAt: now,
      version: i + 1,
      hasSyncignoreMarkers: false,
    }));
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
      ...this.entryPatchFromManifest(manifest),
    });
    this.manifestByWs.set(workspaceId, manifest);
    this.metaByWs.set(workspaceId, EMPTY_META_JSON);
  }

  /** Purge tombstone entries older than `tombstonePurgeDays` and stale `renamedFrom` markers. */
  private purgeTombstones(manifest: CloudManifest): CloudManifest {
    const purgeDays = this.deps.tombstonePurgeDays ?? TOMBSTONE_PURGE_DAYS_DEFAULT;
    if (purgeDays <= 0) {
      return manifest;
    }
    const cutoff = Date.now() - purgeDays * 24 * 60 * 60 * 1000;
    const files = manifest.files.filter((f) => {
      if (!f.removedAt) {
        return true;
      }
      const t = Date.parse(f.removedAt);
      return Number.isNaN(t) || t >= cutoff;
    }).map((f) => {
      if (!f.renamedFrom || !f.renamedAt) {
        return f;
      }
      const t = Date.parse(f.renamedAt);
      if (!Number.isNaN(t) && t < cutoff) {
        const { renamedFrom: _, renamedAt: __, ...rest } = f;
        return rest;
      }
      return f;
    });
    if (files.length === manifest.files.length) {
      return manifest;
    }
    return { ...manifest, files };
  }

  /**
   * Find first matching ConflictRule for the given posixRel path.
   * Uses simple glob matching: `*` matches within segment, `**` matches any depth.
   */
  private matchConflictRule(posixRel: string): ConflictRule | undefined {
    const rules = this.deps.conflictRules;
    if (!rules || rules.length === 0) {
      return undefined;
    }
    for (const rule of rules) {
      if (minimatchGlob(posixRel, rule.pattern)) {
        return rule;
      }
    }
    return undefined;
  }

  /** Apply a matched ConflictRule during syncOneFile (before surfacing conflict to user). */
  private async applyConflictRule(
    cfg: WorkspaceConfig,
    workspaceId: string,
    file: TrackedFile,
    entry: ActiveWorkspaceEntry,
    meta: MetaJson,
    rule: ConflictRule,
  ): Promise<void> {
    let strategy = rule.strategy;
    if (strategy === "newer") {
      const localMtime = await fs.stat(this.localAbs(cfg, file.localPath)).then((s) => s.mtimeMs).catch(() => 0);
      const cloudUpdatedAt = meta.files[file.localPath]?.updatedAt;
      const cloudMs = cloudUpdatedAt ? Date.parse(cloudUpdatedAt) : 0;
      strategy = localMtime >= cloudMs ? "keep-mine" : "take-theirs";
    }
    if (strategy === "keep-mine") {
      if (!isSecondaryWorkspaceInstanceReadOnly() && !(await this.shouldSkipPushDueToMachineApproval(workspaceId))) {
        // pushFile internally fires resolve_keep_mine activity with asAutoResolvedKeepMine=true
        await this.pushFile(cfg, workspaceId, file.localPath, entry, { asAutoResolvedKeepMine: true });
      }
    } else {
      // take-theirs: pullFile fires "pull" activity
      file.syncStatus = "ok";
      await this.pullFile(cfg, workspaceId, file.localPath, entry, meta);
      this.fireActivity({
        kind: "resolve_take_theirs",
        workspaceId,
        workspaceNote: entry.workspaceNote,
        relPath: file.localPath,
        machineName: this.deps.machineName,
        provider: this.deps.provider.type,
        meta: { autoResolved: true, rule: rule.pattern },
      });
    }
  }

  /**
   * Resolve a conflict by keeping the local (mine) version: push local file to cloud, clear conflict status.
   */
  async resolveConflictKeepMine(workspaceId: string, posixRel: string): Promise<void> {
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
    file.syncStatus = "ok";
    await this.pushFile(cfg, workspaceId, posixRel, entry, { asAutoResolvedKeepMine: true });
    await this.saveCfg(cfg);
  }

  /**
   * Resolve a conflict by accepting the cloud (theirs) version: pull cloud file, clear conflict status.
   */
  async resolveConflictTakeTheirs(workspaceId: string, posixRel: string): Promise<void> {
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
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    await this.ensureNotFrozenForCloudWrites(workspaceId);
    try {
      const clean = this.purgeTombstones(manifest);
      // Pre-flight schema validation: never push a manifest that we ourselves
      // would reject on download. Catches accidental shape regressions before
      // they corrupt cloud state for other machines.
      const validation = validateManifestShape(clean);
      if (!validation.ok) {
        throw new Error(`putManifest aborted: ${validation.reason}`);
      }
      // Mass-change guard: ask the UI for confirmation when this push would
      // tombstone a large batch of files (absolute or percent threshold).
      // Only consult on the first attempt — on a 412 retry the merged manifest
      // is the result of our prior intent, so we don't re-prompt.
      if (this.deps.onMassChange && retries === 3) {
        const prev = this.manifestByWs.get(workspaceId);
        const report = detectMassChange(prev, clean);
        if (report.triggered) {
          const proceed = await this.deps.onMassChange(workspaceId, report);
          if (!proceed) throw new Error("putManifest aborted: mass-change guard");
        }
      }
      const body = Buffer.from(`${JSON.stringify(clean, null, 2)}\n`, "utf8");
      const res = await this.deps.provider.uploadFile(manifestCloudPath(workspaceId), body, {
        ifMatch,
      });
      if (res.etag) {
        await this.patchEntry(workspaceId, {
          manifestEtag: res.etag,
          ...this.entryPatchFromManifest(clean),
        });
      }
      this.manifestByWs.set(workspaceId, clean);
      return res.etag;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "PRECONDITION_FAILED" && retries > 0) {
        const entry = (await this.loadCfg()).activeWorkspaces.find((w) => w.workspaceId === workspaceId);
        const remote = await this.downloadManifest(workspaceId, entry?.manifestEtag);
        if (!remote) {
          throw e;
        }
        const merged = mergeCloudManifests(manifest, remote);
        return this.putManifest(workspaceId, merged, entry?.manifestEtag, retries - 1);
      }
      throw e;
    }
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
    const cfg = await WorkspaceConfigManager.load(this.deps.workspaceRoot);
    const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!ent) {
      throw new Error(`workspace ${workspaceId} not active`);
    }
    const meta = await this.pullMeta(workspaceId, ent.metaEtag);
    const updated: MetaJson = { ...meta, files: { ...meta.files } };
    let applied = 0;
    let skippedMissing = 0;
    let skippedDrift = 0;
    let skippedAlreadyDone = 0;
    for (const task of tasks) {
      const row = updated.files[task.relPath];
      if (!row) {
        skippedMissing += 1;
        continue;
      }
      if (typeof row.hashBlake3 === "string" && /^[0-9a-f]{64}$/.test(row.hashBlake3)) {
        skippedAlreadyDone += 1;
        continue;
      }
      const abs = this.localAbs(cfg, task.relPath);
      let buf: Buffer;
      try {
        buf = await fs.readFile(abs);
      } catch {
        skippedMissing += 1;
        continue;
      }
      const dual = hashCanonicalBufferDual(buf, task.relPath, this.hashCfg(task.relPath));
      // Drift guard — if the local file's sha256 differs from the meta's
      // current sha256, refuse to backfill: the local copy is out of sync
      // with the cloud meta and a regular pushFile is the right path.
      if (dual.sha256 !== row.hash) {
        skippedDrift += 1;
        continue;
      }
      updated.files[task.relPath] = { ...row, hashBlake3: dual.blake3 };
      applied += 1;
    }
    if (applied > 0) {
      await this.pushMetaJson(workspaceId, updated, ent.metaEtag);
    }
    return { applied, skippedMissing, skippedDrift, skippedAlreadyDone };
  }

  private async pullMeta(workspaceId: string, ifNoneMatch: string | undefined): Promise<MetaJson> {
    try {
      const dl = await this.deps.provider.downloadFile(metaCloudPath(workspaceId), { ifNoneMatch });
      if (dl.notModified) {
        const cached = this.metaByWs.get(workspaceId);
        if (cached) {
          return cached;
        }
        const full = await this.deps.provider.downloadFile(metaCloudPath(workspaceId));
        if (full.etag) {
          await this.patchEntry(workspaceId, { metaEtag: full.etag });
        }
        const parsed = JSON.parse(full.body.toString("utf8")) as MetaJson;
        this.metaByWs.set(workspaceId, parsed);
        return parsed;
      }
      if (dl.etag) {
        await this.patchEntry(workspaceId, { metaEtag: dl.etag });
      }
      const parsed = JSON.parse(dl.body.toString("utf8")) as MetaJson;
      this.metaByWs.set(workspaceId, parsed);
      return parsed;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        const empty: MetaJson = { files: {} };
        this.metaByWs.set(workspaceId, empty);
        return empty;
      }
      throw e;
    }
  }

  private async pushMetaJson(workspaceId: string, meta: MetaJson, ifMatch: string | undefined): Promise<string> {
    if (isSecondaryWorkspaceInstanceReadOnly() && !isPullMetaCloudWriteActive()) {
      rejectIfSecondaryWorkspaceInstanceReadOnly();
    }
    await this.ensureNotFrozenForCloudWrites(workspaceId);
    let etag = ifMatch;
    let current = meta;
    const metaWriteRetries = this.resolveMetaWriteRetries();
    for (let attempt = 0; attempt < metaWriteRetries; attempt += 1) {
      try {
        const body = Buffer.from(`${JSON.stringify(current, null, 2)}\n`, "utf8");
        const res = await this.deps.provider.uploadFile(metaCloudPath(workspaceId), body, {
          ifMatch: etag,
        });
        if (res.etag) {
          await this.patchEntry(workspaceId, { metaEtag: res.etag });
        }
        this.metaByWs.set(workspaceId, current);
        return res.etag ?? "";
      } catch (e) {
        if (!(e instanceof ProviderError) || e.code !== "PRECONDITION_FAILED") {
          throw e;
        }
        const remoteBuf = await this.deps.provider.downloadFile(metaCloudPath(workspaceId));
        const remote = JSON.parse(remoteBuf.body.toString("utf8")) as MetaJson;
        current = mergeMetaEntries(current, remote);
        etag = remoteBuf.etag;
      }
    }
    throw new Error("pushMetaJson: retries exhausted");
  }

  async syncWorkspace(workspaceId: string, options?: { checkOnly?: boolean }): Promise<void> {
    // v0.7 — opportunistically drain any deferred history snapshots queued
    // by `historyMode = lazy` since the last sync. Cheap when the queue is
    // empty; bounded by `historyVersions` per file otherwise.
    if (this.lazyHistoryQueue.length > 0) {
      const drained = this.drainLazyHistoryQueue();
      try {
        await this.runDeferredHistorySnapshots(drained);
      } catch (e) {
        warnLog("syncEngine", `lazy history drain failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const manifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!manifest) {
      // Manifest is gone from cloud — regardless of whether the folder has leftover content,
      // treat this as intentional deletion by another machine. Auto-detach locally and let
      // the user decide: remove locally (default) or re-upload to cloud.
      const savedEntry = { ...entry };
      const savedFiles = cfg.files.filter((f) => f.workspaceId === workspaceId);
      await this.detachWorkspaceLocal(workspaceId);
      this.deps.onRemoteWorkspaceDeleted?.(
        workspaceId,
        entry.workspaceNote,
        this.deps.workspaceRoot,
        savedEntry,
        savedFiles,
      );
      return;
    }

    // Forward-compat: if the cloud manifest has a newer schemaVersion, skip sync
    // and notify the user to update their extension.
    const rawSchema = (manifest as unknown as { schemaVersion: number }).schemaVersion;
    if (rawSchema > SUPPORTED_MANIFEST_SCHEMA) {
      this.deps.onSchemaVersionTooNew?.(workspaceId, rawSchema);
      return;
    }

    // Detect files that would be silently pruned (tombstone purged while offline)
    // but still exist on disk — warn the user so they're not lost without notice.
    if (this.deps.onPurgeLostFiles) {
      const activePaths = new Set(manifest.files.filter((f) => !f.removedAt).map((f) => f.path));
      const wouldBePruned = cfg.files.filter(
        (f) => f.workspaceId === workspaceId && !activePaths.has(f.localPath),
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

    // Adopt new files added by other machines since last sync (before pruning)
    // Important: must run BEFORE pruneTrackingFromManifest so renamedFrom detection can
    // find the old entry while it still exists in cfg.files.
    await this.adoptManifestFilesFromCloud(workspaceId);

    // Reload cfg after adoption (adoptManifestFilesFromCloud saves its own copy)
    const cfgAfterAdopt = await this.loadCfg();
    this.pruneTrackingFromManifest(cfgAfterAdopt, manifest);
    await this.saveCfg(cfgAfterAdopt);

    if (normalizeWorkspaceSyncState(entry) !== "active") {
      return;
    }

    // Use the fresh config after adopt + prune
    const cfgSync = await this.loadCfg();
    const trackedFiles = cfgSync.files.filter((f) => f.workspaceId === workspaceId);

    // Update soft lock cache from manifest
    const machineById = new Map(entry.manifestMachines?.map((m) => [m.machineId, m.machineName]) ?? []);
    for (const file of trackedFiles) {
      const mf = manifest.files.find((x) => x.path === file.localPath && !x.removedAt);
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
      return;
    }
    const metaNow = await this.pullMeta(workspaceId, entInit.metaEtag);

    await this.iterateTrackedFiles(
      cfgSync,
      workspaceId,
      manifest,
      trackedFiles,
      metaNow,
      options?.checkOnly === true,
    );
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
          const m = manifest.files.find((x) => x.path === file.localPath && !x.removedAt);
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
    const metaRow = meta.files[file.localPath];
    const base = metaRow === undefined ? undefined : metaRow.hash;
    const localCurrent = await computeHash(this.localAbs(cfg, file.localPath), this.hashCfg(file.localPath)).catch(() => "");
    let cloudCurrent = "";
    try {
      const dl = await this.deps.provider.downloadFile(file.cloudPath, { ifNoneMatch: metaRow?.etag });
      if (dl.notModified) {
        cloudCurrent = base ?? "";
      } else {
        cloudCurrent = hashCanonicalBuffer(dl.body, file.localPath, this.hashCfg(file.localPath));
      }
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
      cloudCurrent = "";
    }
    // Meta consensus already updated by another machine; our cached
    // `file.localHash` lags behind. detectChange would call this "push"
    // because it doesn't know `localHash` is stale — but the right
    // verdict is "pull": cloud has changed, we're out of date.
    // (Identical guard exists in syncOneFile:2994-3005 for the full-sync
    //  path; check-only must mirror it or we mis-report status as
    //  pending_push when a remote machine pushed a newer version.)
    const consensusLagsLocally =
      base !== undefined &&
      base !== "" &&
      file.localHash !== base &&
      cloudCurrent === base &&
      localCurrent !== cloudCurrent;
    const action: ChangeAction = consensusLagsLocally
      ? "pull"
      : detectChange(base, localCurrent, cloudCurrent);
    let next: WorkspaceConfig["files"][number]["syncStatus"] = file.syncStatus;
    if (action === "push") next = "pending_push";
    else if (action === "pull") next = "cloud_newer";
    else if (action === "none") next = "ok";
    else next = "conflict";
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
  async checkWorkspaceStatus(workspaceId: string): Promise<void> {
    return this.syncWorkspace(workspaceId, { checkOnly: true });
  }

  private pruneTrackingFromManifest(cfg: WorkspaceConfig, manifest: CloudManifest): void {
    const active = new Set(
      manifest.files.filter((f) => !f.removedAt).map((f) => `${manifest.workspaceId}:${f.path}`),
    );
    cfg.files = cfg.files.filter((f) => {
      if (f.workspaceId !== manifest.workspaceId) {
        return true;
      }
      return active.has(`${f.workspaceId}:${f.localPath}`);
    });
  }

  private async syncOneFile(
    cfg: WorkspaceConfig,
    workspaceId: string,
    file: TrackedFile,
    meta: MetaJson,
    entry: ActiveWorkspaceEntry,
  ): Promise<void> {
    const metaRow = meta.files[file.localPath];
    const base = metaRow === undefined ? undefined : metaRow.hash;
    const localCurrent = await computeHash(this.localAbs(cfg, file.localPath), this.hashCfg(file.localPath)).catch(() => "");
    let cloudCurrent = "";
    let cloudBuf: Buffer | undefined;
    try {
      const dl = await this.deps.provider.downloadFile(file.cloudPath, { ifNoneMatch: metaRow?.etag });
      if (dl.notModified) {
        cloudCurrent = base ?? "";
      } else {
        cloudBuf = dl.body;
        cloudCurrent = hashCanonicalBuffer(dl.body, file.localPath, this.hashCfg(file.localPath));
      }
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
      cloudCurrent = "";
    }
    /** `_meta` already updated by another machine; our cached `localHash` lags behind consensus. */
    if (
      base !== undefined &&
      base !== "" &&
      file.localHash !== base &&
      cloudCurrent === base
    ) {
      if (file.syncStatus !== "cloud_newer") {
        file.syncStatus = "cloud_newer";
        await this.persistMutatedCfg(cfg);
      }
      return;
    }
    const action = detectChange(base, localCurrent, cloudCurrent);
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
      if (file.syncStatus === "cloud_newer") {
        file.syncStatus = "ok";
        await this.persistMutatedCfg(cfg);
      }
    } else if (action === "pull") {
      if (file.syncStatus !== "cloud_newer") {
        file.syncStatus = "cloud_newer";
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
      const rule = this.matchConflictRule(file.localPath);
      if (rule) {
        await this.applyConflictRule(cfg, workspaceId, file, entry, meta, rule);
        return;
      }
      file.syncStatus = "conflict";
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
  async previewSyncPlan(workspaceId?: string): Promise<SyncPreviewWorkspace[]> {
    const cfg = await this.loadCfg();
    const ids = workspaceId
      ? [workspaceId]
      : [...new Set(cfg.activeWorkspaces.map((w) => w.workspaceId))];
    const results: SyncPreviewWorkspace[] = [];

    for (const wsId of ids) {
      const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === wsId);
      if (!entry) {
        continue;
      }

      let manifest: CloudManifest;
      try {
        const manifestDl = await this.deps.provider.downloadFile(manifestCloudPath(wsId));
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
        const metaDl = await this.deps.provider.downloadFile(metaCloudPath(wsId));
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
        (f) => f.workspaceId === wsId && activeManifestPaths.has(f.localPath),
      );

      const rows: SyncPreviewFileRow[] = [];
      for (const file of trackedFiles) {
        if (file.syncStatus === "conflict") {
          rows.push({ localPath: file.localPath, action: "conflict_pending" });
          continue;
        }
        const metaRow = meta.files[file.localPath];
        const base = metaRow === undefined ? undefined : metaRow.hash;
        const localCurrent = await computeHash(this.localAbs(cfg, file.localPath), this.hashCfg(file.localPath)).catch(() => "");
        let cloudCurrent = "";
        try {
          const dl = await this.deps.provider.downloadFile(file.cloudPath);
          cloudCurrent = hashCanonicalBuffer(dl.body, file.localPath, this.hashCfg(file.localPath));
        } catch (e) {
          if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
            throw e;
          }
          cloudCurrent = "";
        }

        let action: PreviewSyncFileAction;
        if (base !== undefined && base !== "" && file.localHash !== base && cloudCurrent === base) {
          action = "pull";
        } else {
          action = detectChange(base, localCurrent, cloudCurrent);
        }
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

    const metaRow = meta.files[file.localPath];
    const base = metaRow === undefined ? undefined : metaRow.hash;
    let cloudCurrent = "";
    let cloudBuf: Buffer | undefined;
    try {
      const dl = await this.deps.provider.downloadFile(file.cloudPath);
      cloudBuf = dl.body;
      cloudCurrent = hashCanonicalBuffer(dl.body, file.localPath, this.hashCfg(file.localPath));
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
      cloudCurrent = "";
    }

    if (base !== undefined && base !== "" && file.localHash !== base && cloudCurrent === base) {
      await this.pullFile(cfg, workspaceId, file.localPath, entry, meta);
      return false;
    }

    const action = detectChange(base, localCurrentHash, cloudCurrent);
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
      if (file.localHash !== localCurrentHash || file.syncStatus !== "ok") {
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
    const rule = this.matchConflictRule(file.localPath);
    if (rule) {
      await this.applyConflictRule(cfg, workspaceId, file, entry, meta, rule);
      return false;
    }
    file.syncStatus = "conflict";
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
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const cfg = await this.loadCfg();
    const ids = workspaceId
      ? [workspaceId]
      : [...new Set(cfg.activeWorkspaces.map((w) => w.workspaceId))];
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
        await this.syncWorkspace(id);
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
        await this.withBatchedCfgWrites(c2, async () => {
          await parallelLimit(
            dirtyFiles,
            async (f) => {
              const localHash = await computeHash(this.localAbs(c2, f.localPath), this.hashCfg(f.localPath));
              if (localHash !== f.localHash) {
                await this.pushFile(c2, id, f.localPath, entry);
                pushedFiles++;
              }
            },
            { concurrency: fileConcurrency },
          );
        });
        results[idx] = { workspaceId: id, ok: true, pushedFiles };
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
    const ids = workspaceId
      ? [workspaceId]
      : [...new Set((await this.loadCfg()).activeWorkspaces.map((w) => w.workspaceId))];
    const workspaceConcurrency = this.resolveWorkspaceConcurrency();
    await parallelLimit(
      ids,
      async (id) => {
        await this.forcePullWorkspace(id);
      },
      { concurrency: workspaceConcurrency },
    );
  }

  /** Force-pulls every tracked file from cloud, bypassing soft locks and detectChange.
   * Runs the same manifest/adopt/prune prep as syncWorkspace; skips conflict files only. */
  private async forcePullWorkspace(workspaceId: string): Promise<void> {
    const cfg = await this.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) {
      throw new Error("workspace not active");
    }
    const manifest = await this.downloadManifest(workspaceId, entry.manifestEtag);
    if (!manifest) {
      const savedEntry = { ...entry };
      const savedFiles = cfg.files.filter((f) => f.workspaceId === workspaceId);
      await this.detachWorkspaceLocal(workspaceId);
      this.deps.onRemoteWorkspaceDeleted?.(
        workspaceId,
        entry.workspaceNote,
        this.deps.workspaceRoot,
        savedEntry,
        savedFiles,
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
      const mf = manifest.files.find((x) => x.path === file.localPath && !x.removedAt);
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
    if (file.syncStatus === "conflict") {
      return;
    }
    const profileStart = this.deps.onSyncProfileSample ? Date.now() : 0;
    const meta = await this.pullMeta(workspaceId, ent.metaEtag);
    const oldBlobPathForHistory = file.cloudPath;
    const abs = this.localAbs(cfg, posixRel);
    await this.assertFileWithinSizeLimit(abs);
    const hashStartMs = this.deps.onSyncProfileSample ? Date.now() : 0;
    const hash = await computeHash(abs, this.hashCfg(posixRel));
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
      const cachedMeta = this.metaByWs.get(workspaceId);
      const metaLocked = cachedMeta ?? (await this.pullMeta(workspaceId, ent.metaEtag));
      const prevLocked = metaLocked.files[posixRel];
      const prevEtagLocked = prevLocked === undefined ? undefined : prevLocked.etag;
      const prevWireGzipLocked = prevLocked?.wireGzip === true;
      await this.snapshotHistory(workspaceId, posixRel, oldBlobPathForHistory);
      const plaintextBufLocked = await fs.readFile(abs);
      // v0.7 — only re-hash when the file changed between the unlocked
      // pre-check and acquiring the lock. We detect that via mtime stat on
      // the path (cheap) — if unchanged, reuse `hash` from above.
      let hashLocked = hash;
      try {
        const st = await fs.stat(abs);
        // Re-hash only if the file was rewritten between the unlocked
        // pre-check and acquiring the lock. The fast-path detects "nothing
        // changed" via size; equal size with different content still races
        // through to the safe re-hash branch below via the catch path.
        if (plaintextBufLocked.length !== st.size) {
          const hashStart2 = this.deps.onSyncProfileSample ? Date.now() : 0;
          hashLocked = await computeHash(abs, this.hashCfg(posixRel));
          if (this.deps.onSyncProfileSample) {
            hashMsAccum += Date.now() - hashStart2;
          }
        }
      } catch {
        const hashStart2 = this.deps.onSyncProfileSample ? Date.now() : 0;
        hashLocked = await computeHash(abs, this.hashCfg(posixRel));
        if (this.deps.onSyncProfileSample) {
          hashMsAccum += Date.now() - hashStart2;
        }
      }

      if (
        isDeltaSyncEligible({
          deltaSync: this.deps.deltaSync ?? false,
          deltaThresholdKB: this.deps.deltaThresholdKB ?? 100,
          plaintextByteLength: plaintextBufLocked.length,
        })
      ) {
        // §8.2: rolling-hash delta + conditional GET — not implemented; upload proceeds as full body below.
      }

      let wireGzip = false;
      let gzipWireBody: Buffer | undefined;
      if (this.deps.compressUploads && plaintextLooksCompressible(posixRel, plaintextBufLocked)) {
        gzipWireBody = gzipIfShrinks(plaintextBufLocked);
        wireGzip = gzipWireBody !== undefined;
      }

      const uploadCloudPath = blobCloudPath(workspaceId, posixRel, wireGzip);
      const pathModeChanged =
        uploadCloudPath !== file.cloudPath ||
        prevWireGzipLocked !== wireGzip ||
        oldBlobPathForHistory !== uploadCloudPath;

      let uploadBuf: Buffer;
      if (wireGzip && gzipWireBody !== undefined) {
        uploadBuf = this.deps.encrypt ? this.deps.encrypt(gzipWireBody) : gzipWireBody;
      } else {
        uploadBuf = this.deps.encrypt ? this.deps.encrypt(plaintextBufLocked) : plaintextBufLocked;
      }

      const ifMatchBlob = pathModeChanged ? undefined : prevEtagLocked;
      let etag = prevEtagLocked;
      const networkStartMs = this.deps.onSyncProfileSample ? Date.now() : 0;
      try {
        const res = await this.deps.provider.uploadFile(uploadCloudPath, uploadBuf, { ifMatch: ifMatchBlob });
        etag = res.etag ?? etag;
        const networkMs = this.deps.onSyncProfileSample ? Date.now() - networkStartMs : 0;
        // v0.7 — verifyUploadHash setting gate. Default `plaintext-only`
        // keeps the historical behaviour; `never` skips entirely.
        const verifyMode = this.resolveVerifyUploadHash();
        const wantVerify = verifyMode !== "never" && !this.deps.encrypt;
        const verifyStartMs = this.deps.onSyncProfileSample && wantVerify ? Date.now() : 0;
        if (wantVerify) {
          await this.verifyUploadPlaintextHash(uploadCloudPath, hashLocked, posixRel, wireGzip);
        }
        // v0.18 D01 — additional provider-side digest check. When the
        // provider exposes md5/sha1/sha256 via getMetadata, we compute
        // the expected digest locally and compare. Skip for encrypted
        // uploads (provider sees ciphertext, not plaintext) and for
        // wire-compressed uploads (provider digests the .gz bytes, not
        // the plaintext we hold).
        if (
          !this.deps.encrypt &&
          !wireGzip &&
          this.resolveProviderHashVerify()
        ) {
          try {
            const meta = await this.deps.provider.getMetadata(uploadCloudPath);
            if (meta?.etag) {
              const { expectedProviderDigests, digestEquals } = await import("./providerHashVerify.js");
              const expected = expectedProviderDigests(this.deps.provider.type, plaintextBufLocked);
              // Provider's etag string sometimes IS the md5 hex (gdrive,
              // yandex). Match against any expected digest; mismatch with
              // ALL of them → INTEGRITY_FAILED.
              const cleaned = (meta.etag ?? "").replace(/^"+|"+$/g, "").toLowerCase();
              const matched = expected.some((d) => digestEquals(d.value, cleaned));
              if (!matched && cleaned.length >= 32) {
                // Provider returned a digest-looking ETag but it doesn't
                // match any of our computed hashes — likely corruption.
                throw new ProviderError(
                  "INTEGRITY_FAILED",
                  `Provider digest mismatch on ${posixRel}: provider=${cleaned} expected one of [${expected.map((d) => d.value).join(", ")}]`,
                );
              }
            }
          } catch (e) {
            if (e instanceof ProviderError && e.code === "INTEGRITY_FAILED") throw e;
            // Other failures (NOT_FOUND on metadata, network blip) are
            // non-fatal; the standard plaintext verify above already
            // caught the most common corruption mode.
          }
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
          const dual = hashCanonicalBufferDual(plaintextBufLocked, posixRel, this.hashCfg(posixRel));
          row.hashBlake3 = dual.blake3;
        }
        const nextMeta: MetaJson = {
          ...metaLocked,
          files: {
            ...metaLocked.files,
            [posixRel]: row,
          },
        };
        await this.pushMetaJson(workspaceId, nextMeta, ent.metaEtag);
        if (this.deps.onPushFile) {
          try {
            this.deps.onPushFile(workspaceId, posixRel, plaintextBufLocked, {
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
        if (wireGzip && gzipWireBody !== undefined) {
          const saved = plaintextBufLocked.length - gzipWireBody.length;
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

  private async pushBlobRaw(cloudPath: string, abs: string): Promise<void> {
    rejectIfSecondaryWorkspaceInstanceReadOnly();
    const buf = await fs.readFile(abs);
    await this.deps.provider.uploadFile(cloudPath, buf);
    this.emitTransfer({ direction: "upload", bytes: buf.length });
  }

  private async verifyUploadPlaintextHash(
    cloudPath: string,
    expectedPlaintextHash: string,
    posixRel: string,
    wireGzip: boolean,
  ): Promise<void> {
    const verifyRetries = this.resolveVerifyRetries();
    for (let i = 0; i < verifyRetries; i += 1) {
      const got = await this.deps.provider.downloadFile(cloudPath);
      let body = got.body;
      if (wireGzip) {
        body = gunzipToPlaintext(body);
      }
      const h = hashCanonicalBuffer(body, posixRel, this.hashCfg(posixRel));
      if (h === expectedPlaintextHash) {
        return;
      }
    }
    throw new Error("verifyUploadPlaintextHash: hash mismatch after retries");
  }

  private async deleteRemoteBlobBestEffort(cloudPath: string): Promise<void> {
    try {
      await this.deps.provider.deleteFile(cloudPath);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        return;
      }
      warnLog(
        "syncEngine",
        `deleteRemoteBlobBestEffort(${cloudPath}) suppressed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async snapshotHistory(workspaceId: string, posixRel: string, cloudPath: string): Promise<void> {
    const mode = this.resolveHistoryMode();
    if (mode === "off") return;
    if (mode === "lazy") {
      const entry: LazyHistoryEntry = {
        workspaceId,
        posixRel,
        oldCloudPath: cloudPath,
        queuedAtMs: Date.now(),
      };
      this.lazyHistoryQueue.push(entry);
      this.deps.onLazyHistoryQueued?.(entry);
      return;
    }
    await this.snapshotHistoryNow(workspaceId, posixRel, cloudPath);
  }

  private async snapshotHistoryNow(workspaceId: string, posixRel: string, cloudPath: string): Promise<void> {
    try {
      const cur = await this.deps.provider.downloadFile(cloudPath);
      if (cur.notModified || cur.body.length === 0) {
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = posixRel.includes(".") ? posixRel.slice(posixRel.lastIndexOf(".")) : "";
      const safeMachine = this.deps.machineName.replace(/[/\\:*?"<>|]/g, "_");
      const histPath = `${historyDirForFile(workspaceId, posixRel)}/${stamp}_${safeMachine}${ext}`;
      await this.deps.provider.uploadFile(histPath, cur.body);
      await this.pruneHistory(workspaceId, posixRel);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        return;
      }
      throw e;
    }
  }

  private async pruneHistory(workspaceId: string, posixRel: string): Promise<void> {
    const dir = historyDirForFile(workspaceId, posixRel);
    const items = await this.deps.provider.listFolder(dir);
    const historyVersions = this.resolveHistoryVersions();
    if (items.length <= historyVersions) {
      return;
    }
    const sorted = [...items].sort((a, b) => a.cloudPath.localeCompare(b.cloudPath));
    const drop = sorted.slice(0, Math.max(0, sorted.length - historyVersions));
    for (const d of drop) {
      await this.deps.provider.deleteFile(d.cloudPath);
    }
  }

  async pullFile(
    cfg: WorkspaceConfig,
    workspaceId: string,
    posixRel: string,
    entry?: ActiveWorkspaceEntry,
    metaIn?: MetaJson,
  ): Promise<"updated" | "already_current"> {
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
    if (file.syncStatus === "conflict") {
      throw new Error("файл в конфликте — используйте «Принять моё» или «Принять их версию»");
    }
    const meta = metaIn ?? (await this.pullMeta(workspaceId, ent.metaEtag));
    const metaRow = meta.files[posixRel];
    const abs = this.localAbs(cfg, posixRel);
    const hadLocal = await fileExists(abs);
    let localCanon = "";
    if (hadLocal) {
      localCanon = await computeHash(abs, this.hashCfg(posixRel)).catch(() => "");
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
    const downloadPath = blobCloudPath(workspaceId, posixRel, wireGzip);
    const dl = await this.deps.provider.downloadFile(downloadPath, {
      ifNoneMatch,
    });
    // X1 — provider digest verify on pull. Mirrors the push-side D01
    // check: when the provider's metadata exposes md5/sha1/sha256, compare
    // it against the digest we'd compute from the downloaded body. Skip
    // for encrypted reads (the provider sees ciphertext) and for
    // wire-compressed blobs (provider digests the .gz, not plaintext).
    if (
      !dl.notModified &&
      !this.deps.decrypt &&
      !wireGzip &&
      this.resolveProviderHashVerify()
    ) {
      try {
        if (dl.etag) {
          const { expectedProviderDigests, digestEquals } = await import("./providerHashVerify.js");
          const expected = expectedProviderDigests(this.deps.provider.type, dl.body);
          const cleaned = dl.etag.replace(/^"+|"+$/g, "").toLowerCase();
          const matched = expected.some((d) => digestEquals(d.value, cleaned));
          if (!matched && cleaned.length >= 32) {
            throw new ProviderError(
              "INTEGRITY_FAILED",
              `Provider digest mismatch on pull ${posixRel}: provider=${cleaned} expected one of [${expected.map((d) => d.value).join(", ")}]`,
            );
          }
        }
      } catch (e) {
        if (e instanceof ProviderError && e.code === "INTEGRITY_FAILED") throw e;
        // Other failures (provider doesn't expose etag-as-digest, etc.)
        // are non-fatal — local canonical hash check below catches the
        // common corruption case anyway.
      }
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
    let rawBody: Buffer = this.deps.decrypt ? this.deps.decrypt(dl.body) : dl.body;
    if (wireGzip) {
      rawBody = gunzipToPlaintext(rawBody);
    }
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
    const hash = await computeHash(abs, this.hashCfg(posixRel));
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
        [posixRel]: rowMeta,
      },
    };
    await withPullCloudMetaWriteAllowed(() => this.pushMetaJson(workspaceId, nextMeta, ent.metaEtag));
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
    const dir = historyDirForFile(hit.workspaceId, posixRel);
    const items = await this.deps.provider.listFolder(dir);
    const baseName = (p: string): string => {
      const i = p.lastIndexOf("/");
      return i >= 0 ? p.slice(i + 1) : p;
    };
    return [...items].sort((a, b) => baseName(b.cloudPath).localeCompare(baseName(a.cloudPath)));
  }

  /** Скачать снимок истории, если путь принадлежит `.history/` этого файла. Декодируется decrypt + gunzip как у текущего файла по `_meta.wireGzip`. */
  async downloadHistorySnapshotIfOwned(posixRel: string, historyCloudPath: string): Promise<Buffer> {
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
    const row = meta.files[posixRel];
    const wireGzip = row?.wireGzip === true;
    const prefix = `${historyDirForFile(hit.workspaceId, posixRel)}/`;
    const norm = historyCloudPath.replace(/\/$/, "");
    if (!norm.startsWith(prefix)) {
      throw new Error("not a history path for this file");
    }
    let dl = await this.deps.provider.downloadFile(norm);
    if (dl.notModified && dl.body.length === 0) {
      dl = await this.deps.provider.downloadFile(norm);
    }
    let body: Buffer = dl.body;
    body = this.deps.decrypt ? this.deps.decrypt(body) : body;
    if (wireGzip) {
      body = gunzipToPlaintext(body);
    }
    return body;
  }

  /** Raw cloud bytes for tracked file decoded to canonical plaintext UTF-8 (decrypt + optional gunzip). */
  async downloadTrackedBlob(posixRel: string): Promise<{ body: Buffer }> {
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
    const row = meta.files[posixRel];
    const wireGzip = row?.wireGzip === true;
    const path = blobCloudPath(hit.workspaceId, posixRel, wireGzip);
    let dl = await this.deps.provider.downloadFile(path);
    if (dl.notModified && dl.body.length === 0) {
      dl = await this.deps.provider.downloadFile(path);
    }
    let body: Buffer = dl.body;
    body = this.deps.decrypt ? this.deps.decrypt(body) : body;
    if (wireGzip) {
      body = gunzipToPlaintext(body);
    }
    return { body };
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

async function backupLocalWithPrune(
  localFileAbs: string,
  workspaceRoot: string,
  posixRelMirror: string,
  retentionDays: number,
  backupDir: string,
): Promise<void> {
  const src = localFileAbs;
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const dest = path.join(workspaceRoot, backupDir, stamp, ...posixRelMirror.split("/"));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  if (retentionDays > 0) {
    await pruneLocalBackups(workspaceRoot, retentionDays, backupDir);
  }
}

async function pruneLocalBackups(workspaceRoot: string, retentionDays: number, backupDir: string): Promise<void> {
  const root = path.join(workspaceRoot, backupDir);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  const entries = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(root, name));
      entries.push({ name, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
    } catch {
      /* skip — disappeared between readdir and stat */
    }
  }
  const plan = planLocalBackupRetention({ entries, retentionDays });
  await Promise.all(
    plan.delete.map((name) => fs.rm(path.join(root, name), { recursive: true, force: true })),
  );
}
