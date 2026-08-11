/** Типы провайдеров облака (v1: один активный глобально). */
export type ProviderType = "onedrive" | "gdrive" | "yandex" | "dropbox";

/** Метаданные провайдера в config.json (без секретов). */
export interface ProviderTokens {
  accountLabel?: string;
  lastUsedIso?: string;
}

export interface GlobalConfig {
  activeProvider: ProviderType | null;
  machineId: string;
  machineName: string;
  /** false = показать мастер при следующем запуске. У старых config без поля — true (миграция). */
  onboardingCompleted: boolean;
  /**
   * Legacy persisted pause flag (config.json). Migrated once at extension activate into `syncSessionPause`;
   * new pauses do not set this field.
   */
  syncPaused: boolean;
  /** Только нечувствительные метаданные; секреты — в SecretStorage. */
  providers: Partial<Record<ProviderType, ProviderTokens>>;
}

export interface ManifestMachineCacheEntry {
  machineId: string;
  machineName: string;
  lastSeen: string;
  /** Mirrored from cloud manifest `machines[].status`. */
  status?: "active" | "pending" | "blocked";
}

/** Локальное состояние синхронизации workspace (`docs/v1/04-reliability/roadmap.md` §4.3). `undefined` = активен. */
export type WorkspaceSyncState = "active" | "suspended" | "frozen";

export function normalizeWorkspaceSyncState(
  entry: Pick<ActiveWorkspaceEntry, "syncState"> | undefined,
): WorkspaceSyncState {
  const s = entry?.syncState;
  if (s === "suspended" || s === "frozen") {
    return s;
  }
  return "active";
}

export interface ActiveWorkspaceEntry {
  workspaceId: string;
  workspaceNote: string;
  /** Suspend: без push/pull файлов; Freeze: также без записи манифеста и `_meta`. */
  syncState?: WorkspaceSyncState;
  /**
   * Кэш `gitBranch` из облачного манифеста (см. команда Set Git Branch).
   * Если задан: при auto Git sync workspace привязывается к текущей ветке.
   */
  gitBranch?: string;
  /** Кэш тегов из облачного манифеста (источник истины — манифест). */
  tags?: string[];
  /** Кэш `machines[]` из облачного манифеста workspace (lastSeen для панели). */
  manifestMachines?: ManifestMachineCacheEntry[];
  /** Провайдер облака из манифеста workspace (после pull — для фильтра UI при смене activeProvider). */
  providerType?: ProviderType;
  saveDebounceSec?: number;
  /** Local machine-specific ignore overrides (stored in `.vscode/vscodesync.json`). */
  ignorePatterns?: string[];
  /** Cache of cloud manifest `sharedIgnorePatterns`; refreshed when the manifest syncs. */
  sharedIgnorePatterns?: string[];
  manifestEtag?: string;
  /** ETag последнего успешного PUT `_meta.json`. */
  metaEtag?: string;
}

/**
 * `missing_local`: the file is tracked but absent on disk (bound file not yet
 * pulled, or moved away without rebinding). Before Link Bindings this state hid
 * as `localHash: ""` + `cloud_newer` and decorations showed it as synced.
 */
export type TrackedSyncStatus = "ok" | "conflict" | "pending_push" | "cloud_newer" | "missing_local";

export interface TrackedFile {
  localPath: string;
  workspaceId: string;
  cloudPath: string;
  lastSync: string;
  /** SHA-256 канонического содержимого на момент последней успешной синхронизации. */
  localHash: string;
  syncStatus?: TrackedSyncStatus;
  /** Cached from cloud manifest: machineId currently editing this file (soft lock). */
  editingBy?: string;
  /** Human-readable machine name for the soft lock owner (for tooltip). */
  editingByName?: string;
  /**
   * Canonical hash of the cloud version at the moment the conflict was flagged.
   *
   * "Keep Mine" overwrites the cloud copy; without this the engine could not
   * tell apart "the cloud version the user chose to discard" from "a newer
   * version another machine pushed after the conflict was raised". Undefined
   * when the conflict came from a 412 during upload — the cloud side was never
   * read there.
   */
  conflictCloudHash?: string;
  /**
   * Link Bindings (docs/v2/linkBindings.md): canonical manifest key — the
   * `ManifestFile.path` / `_meta.files` key this row syncs against. Absent ⇒
   * semantically equal to `localPath` (bound at the canonical path), which
   * keeps every pre-bindings config valid without migration. Written only when
   * a binding is created. Always read via `manifestKeyOf`.
   */
  manifestPath?: string;
  /** Cache of the manifest row's `linkId` (re-association after canonical renames). */
  linkId?: string;
}

export interface WorkspaceConfig {
  activeWorkspaces: ActiveWorkspaceEntry[];
  files: TrackedFile[];
  /**
   * Maps machine name (`GlobalConfig.machineName`) → absolute root where synced files live on that machine.
   * Paths in manifest/`files[].localPath` are relative to this root (fallback: VS Code workspace folder).
   */
  pathMapping?: Record<string, string>;
}

/** Хранилище секретов (VS Code SecretStorage или мок в тестах). */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

