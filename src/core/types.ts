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

export type TrackedSyncStatus = "ok" | "conflict" | "pending_push" | "cloud_newer";

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

/** Strategy for auto-resolving a conflict without user interaction. */
export type ConflictStrategy = "keep-mine" | "take-theirs" | "newer";

/** Auto-conflict-resolution rule: if the tracked file path matches `pattern` (minimatch glob), apply `strategy`. */
export interface ConflictRule {
  /** Minimatch glob relative to workspace root (e.g. "*.lock", "config/shared/**"). */
  pattern: string;
  strategy: ConflictStrategy;
}

/** Хранилище секретов (VS Code SecretStorage или мок в тестах). */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export const SECRET_KEY_PREFIX = "vscodesync.token.";

export function secretKeyForProvider(type: ProviderType): string {
  return `${SECRET_KEY_PREFIX}${type}`;
}
