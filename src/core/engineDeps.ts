/**
 * What the `SyncEngine` depends on, in three groups.
 *
 * The interface used to be one flat list of 46 members (41 of them optional)
 * inside `syncEngine.ts`, which is where "what does this engine actually need?"
 * became unanswerable. The split is by question:
 *   - `EnginePorts` — what it is connected to (cloud, identity, crypto);
 *   - `EngineConfig` — how it is configured (resolvers, read when needed, so a
 *     settings change lands without rebuilding the engine);
 *   - `EngineEvents` — what it reports outwards (all optional: an engine with
 *     no listeners still syncs correctly, it is just silent).
 *
 * `SyncEngineDeps` stays their intersection: the 24 construction sites pass one
 * flat object, and nesting it would be churn without a reader benefit.
 */
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncTrigger } from "./syncPolicy.js";
import type { MassChangeReport } from "./massChangeGuard.js";
import type { LineEndingMode } from "../utils/normalize.js";
import type { ActivityEventInput } from "./activityLog.js";
import type { SyncTransferEvent } from "./syncStatsStore.js";
import type { ActiveWorkspaceEntry, TrackedFile } from "./types.js";
import type { LazyHistoryEntry } from "./io/historyStore.js";
import type { PurgeLostFileItem, SyncProfileSample } from "./syncEngine.js";

/**
 * What the engine talks to: the outside world it cannot invent for itself.
 *
 * Split out of the flat 46-member `SyncEngineDeps` (этап 5.3). The three
 * groups answer three different questions — what am I connected to, how am I
 * configured, and who do I report to — and `SyncEngineDeps` remains their
 * intersection so every construction site keeps passing one object.
 */

export interface EnginePorts {
  workspaceRoot: string;
  provider: ICloudProvider;
  machineId: string;
  machineName: string;
  /**
   * Who this engine acts for — the single mutation checkpoint (F2).
   *
   * Required on purpose. `encKey` was optional and 17 of the 24 construction
   * sites never passed it, which turned encryption off without a word; an
   * optional trigger would fail the same way, defaulting to the permissive
   * answer. Required makes the compiler ask every construction site whether it
   * is a human or a timer.
   */
  trigger: SyncTrigger;
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
  /**
   * True when the user has turned encryption on.
   *
   * `encrypt`/`decrypt` being optional used to mean that an engine built
   * without them worked happily in plaintext. That is precisely what happened:
   * the key reached only 7 of 24 construction sites, and every automatic
   * trigger built its engine without one. With encryption enabled that engine
   * uploaded plaintext over encrypted blobs (recording a valid `_meta.hash`, so
   * nothing ever corrected it) and wrote ciphertext straight over the user's
   * local file on pull. This flag lets the engine tell "encryption is off" from
   * "encryption is on and the key is missing" and refuse the latter.
   */
  encryptionRequired?: boolean;
  /**
   * v0.18 D06 — opt-in trust check. When set, `requireMachineApproval`
   * flow skips approval gate for machineIds the user has marked as
   * trusted. Default (no callback): legacy behaviour — every new machine
   * is `pending` until manually approved on another machine.
   */
  isTrustedTeammate?: (machineId: string) => boolean;
  /**
   * Cancellation for this operation (A5).
   *
   * The engine is built per operation (`makeEngine` runs inside every
   * `runWithEngine`), so a signal here scopes to exactly one user action. It is
   * checked between files and passed to every upload and download, which are
   * the calls long enough to be worth interrupting. Absent means "not
   * cancellable" — the behaviour every caller had before.
   */
  abortSignal?: AbortSignal;
}


/**
 * Settings resolvers. Each is read at the moment it is needed, so a change in
 * the editor's configuration takes effect without rebuilding the engine.
 */

export interface EngineConfig {
  /** Лимит размера одного файла (байт). Не задан или 0 — без лимита (тесты). */
  maxFileSizeBytes?: number;
  /** Нормализация строк при хэше; по умолчанию `lf` (тесты). */
  lineEnding?: LineEndingMode;
  /** Локальная копия перед перезаписью при pull. По умолчанию true. */
  localBackupEnabled?: boolean;
  /** Удалять каталоги бэкапов старше N дней (mtime). `0` — не чистить. По умолчанию 7. */
  localBackupRetentionDays?: number;
  /** When `fileEncoding` is utf8 (default): BOM / invalid UTF-8 hints during hashing. */
  encodingLint?: boolean;
  /** When true: new machines joining an existing workspace manifest get `pending` until approved on another machine. */
  requireMachineApproval?: () => boolean;
  /** User setting: gzip text uploads when `_meta` records `wireGzip`. Default false. */
  compressUploads?: boolean;
  /** Days after which tombstone entries (removedAt) are purged from the manifest on next PUT. Default 30. */
  tombstonePurgeDays?: number;
  /**
   * Returns the current `vscodesync.canonicalHashAlgo` setting. When the
   * caller resolves `"blake3"` or `"dual"`, `pushFile` writes both `hash`
   * (SHA-256, wire-compat) and `hashBlake3` into the meta entry. Default
   * `"sha256"` keeps legacy behaviour (no BLAKE3 column).
   */
  canonicalHashAlgo?: () => "sha256" | "blake3" | "dual";
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
}


/** Everything the engine reports outwards. All optional: an engine with no
 * listeners still syncs correctly, it is just silent. */

export interface EngineEvents {
  onEncodingIssue?: (kind: "bom" | "invalid_utf8", trackedPosixRel: string) => void;
  /** When `lineEnding=preserve` and conflict is likely CRLF vs LF only (LF-canonical hashes match). */
  onPreserveLineEndingConflictHint?: (trackedPosixRel: string) => void;
  /** Local activity log (Activity Feed); optional to keep tests and headless engines quiet. */
  onSyncActivity?: (ev: ActivityEventInput) => void;
  /** Bytes on the wire for tracked file upload/download (stats.json). */
  onTransfer?: (ev: SyncTransferEvent) => void;
  /**
   * Estimated plaintext bytes spared when gzip wire encoding is smaller than raw UTF-8 plaintext.
   */
  onCompressionSaving?: (plaintextBytesSaved: number) => void;
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
   * (manifest NOT_FOUND).
   * UI layer should notify the user and optionally offer to re-upload via `repushWorkspaceToCloud`.
   *
   * `detached` says whether the local workspace and its tracking were actually
   * removed. A background run only reports the finding — dropping tracking is a
   * mutation, so it waits for the user. The two cases need different wording:
   * "detached locally" is a statement of fact in one and a lie in the other.
   */
  onRemoteWorkspaceDeleted?: (
    workspaceId: string,
    workspaceNote: string,
    workspaceRoot: string,
    savedEntry: ActiveWorkspaceEntry,
    savedFiles: TrackedFile[],
    detached: boolean,
  ) => void;
  /**
   * The cloud manifest lists files this machine does not track, or the machine
   * tracks files the manifest no longer has — and the current pass is not
   * allowed to change that. Fires only from the detector; a user-triggered pass
   * applies the difference instead of reporting it.
   */
  onTrackingDriftDetected?: (drift: {
    workspaceId: string;
    workspaceNote: string;
    /** In the cloud manifest, not tracked here. */
    toAdopt: readonly string[];
    /** Tracked here, gone from the cloud manifest. */
    toPrune: readonly string[];
  }) => void;
  /**
   * Canonical path editing: another machine renamed files canonically while
   * this machine keeps its own placement. The engine re-associated the rows
   * (metadata only; the bytes stayed at each `localPlacement`) — the UI offers
   * "переместить у меня" as an explicit user action. ONE call per adopt pass
   * with every replayed rename, so a folder move of N files makes one toast,
   * not N.
   */
  onCanonicalRenamesReplayed?: (
    workspaceId: string,
    notices: readonly {
      from: string;
      to: string;
      /** Where the file still lives on this machine. */
      localPlacement: string;
    }[],
  ) => void;
  /**
   * Canonical path editing: this machine's rename batch lost a concurrent
   * race — after the 412-merge some heirs are no longer live (another
   * machine's rename won). Silence here would silently discard user intent.
   */
  onCanonicalRenameOverridden?: (
    workspaceId: string,
    moves: readonly { from: string; to: string }[],
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
    report: MassChangeReport,
  ) => Promise<boolean>;
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


/**
 * The engine's full dependency set. Kept as an intersection rather than a
 * nested shape: the 24 construction sites pass one flat object, and turning
 * that into three nested ones would be churn without a reader benefit.
 */
export type SyncEngineDeps = EnginePorts & EngineConfig & EngineEvents;
