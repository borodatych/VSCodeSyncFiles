import type {
  ActiveWorkspaceEntry,
  TrackedFile,
  TrackedSyncStatus,
  WorkspaceConfig,
  WorkspaceSyncState,
} from "./types.js";

const EXPORT_SCHEMA = 1 as const;
/** Портативный экспорт: только id, заметка и относительные пути (см. docs/v1/07-ux-polish/roadmap §7.6). */
export const WORKSPACE_STRUCTURE_LITE_SCHEMA = 2 as const;

const SYNC_STATUSES: TrackedSyncStatus[] = ["ok", "conflict", "pending_push", "cloud_newer", "missing_local"];

export interface WorkspaceStructureLite {
  schema: typeof WORKSPACE_STRUCTURE_LITE_SCHEMA;
  sourceWorkspaceId: string;
  workspaceNote: string;
  files: string[];
  exportedAt: string;
  exportedBy: string;
}

export type WorkspaceStructureImportKind = "full_cache" | "lite_portable";

/** Определить формат импорта до разбора полей. */
export function classifyWorkspaceStructureImport(data: unknown): WorkspaceStructureImportKind | "invalid" {
  if (data === null || typeof data !== "object") {
    return "invalid";
  }
  const o = data as Record<string, unknown>;
  if (o.schema === WORKSPACE_STRUCTURE_LITE_SCHEMA) {
    return "lite_portable";
  }
  if (
    typeof o.sourceWorkspaceId === "string" &&
    o.sourceWorkspaceId.length > 0 &&
    typeof o.workspaceNote === "string" &&
    Array.isArray(o.files) &&
    o.files.length > 0 &&
    o.files.every((f) => typeof f === "string")
  ) {
    const sch = o.schema;
    if (sch === undefined || sch === WORKSPACE_STRUCTURE_LITE_SCHEMA) {
      return "lite_portable";
    }
  }
  if (Array.isArray(o.activeWorkspaces) && Array.isArray(o.files)) {
    if (
      o.files.length === 0 ||
      (typeof o.files[0] === "object" &&
        o.files[0] !== null &&
        "localPath" in (o.files[0] as Record<string, unknown>))
    ) {
      return "full_cache";
    }
  }
  return "invalid";
}

/** Разбор портативного JSON (schema 2). */
export function parseWorkspaceStructureLite(data: unknown): WorkspaceStructureLite {
  if (data === null || typeof data !== "object") {
    throw new Error("неверный JSON");
  }
  const o = data as Record<string, unknown>;
  if (typeof o.schema === "number" && o.schema !== WORKSPACE_STRUCTURE_LITE_SCHEMA) {
    throw new Error(`портативный формат ожидает schema ${String(WORKSPACE_STRUCTURE_LITE_SCHEMA)}`);
  }
  if (typeof o.sourceWorkspaceId !== "string" || o.sourceWorkspaceId.trim() === "") {
    throw new Error("нужна непустая строка sourceWorkspaceId");
  }
  if (typeof o.workspaceNote !== "string") {
    throw new Error("нужна строка workspaceNote");
  }
  if (!Array.isArray(o.files) || o.files.length === 0) {
    throw new Error("нужен непустой массив files с относительными путями");
  }
  const files = o.files.filter((f): f is string => typeof f === "string").map((f) => f.split(/[/\\]+/).join("/").replace(/^\//, ""));
  const bad = files.find((f) => f.length === 0 || f.includes(".."));
  if (bad !== undefined) {
    throw new Error(`недопустимый путь в files: ${bad}`);
  }
  const exportedAt = typeof o.exportedAt === "string" ? o.exportedAt : new Date().toISOString();
  const exportedBy = typeof o.exportedBy === "string" ? o.exportedBy : "";
  return {
    schema: WORKSPACE_STRUCTURE_LITE_SCHEMA,
    sourceWorkspaceId: o.sourceWorkspaceId.trim(),
    workspaceNote: o.workspaceNote,
    files: [...new Set(files)],
    exportedAt,
    exportedBy,
  };
}

function parseSyncState(raw: unknown): WorkspaceSyncState | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (raw === "active" || raw === "suspended" || raw === "frozen") {
    return raw;
  }
  return undefined;
}

function parseActiveEntry(raw: unknown, i: number): ActiveWorkspaceEntry {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`activeWorkspaces[${String(i)}]: ожидается объект`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.workspaceId !== "string" || typeof o.workspaceNote !== "string") {
    throw new Error(`activeWorkspaces[${String(i)}]: нужны строки workspaceId и workspaceNote`);
  }
  const syncState = parseSyncState(o.syncState);
  return {
    workspaceId: o.workspaceId,
    workspaceNote: o.workspaceNote,
    ...(syncState !== undefined ? { syncState } : {}),
    saveDebounceSec: typeof o.saveDebounceSec === "number" ? o.saveDebounceSec : undefined,
    gitBranch: typeof o.gitBranch === "string" && o.gitBranch.trim() !== "" ? o.gitBranch.trim() : undefined,
    ignorePatterns: Array.isArray(o.ignorePatterns)
      ? o.ignorePatterns.filter((p): p is string => typeof p === "string")
      : undefined,
    sharedIgnorePatterns: Array.isArray(o.sharedIgnorePatterns)
      ? o.sharedIgnorePatterns.filter((p): p is string => typeof p === "string")
      : undefined,
    manifestEtag: typeof o.manifestEtag === "string" ? o.manifestEtag : undefined,
    metaEtag: typeof o.metaEtag === "string" ? o.metaEtag : undefined,
    tags: Array.isArray(o.tags)
      ? [...new Set(o.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()))].filter(
          (t) => t.length > 0,
        )
      : undefined,
    manifestMachines: Array.isArray(o.manifestMachines)
      ? o.manifestMachines
          .filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
          .flatMap((m) => {
            const id = m.machineId;
            const name = m.machineName;
            const seen = m.lastSeen;
            if (typeof id !== "string" || typeof name !== "string" || typeof seen !== "string") {
              return [];
            }
            return [{ machineId: id, machineName: name, lastSeen: seen }];
          })
      : undefined,
  };
}

function normSyncStatus(v: unknown): TrackedSyncStatus | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  return SYNC_STATUSES.includes(v as TrackedSyncStatus) ? (v as TrackedSyncStatus) : undefined;
}

function parseTrackedFile(raw: unknown, i: number): TrackedFile {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`files[${String(i)}]: ожидается объект`);
  }
  const o = raw as Record<string, unknown>;
  if (
    typeof o.localPath !== "string" ||
    typeof o.workspaceId !== "string" ||
    typeof o.cloudPath !== "string"
  ) {
    throw new Error(`files[${String(i)}]: нужны localPath, workspaceId, cloudPath`);
  }
  const lastSync = typeof o.lastSync === "string" ? o.lastSync : "";
  const localHash = typeof o.localHash === "string" ? o.localHash : "";
  return {
    localPath: o.localPath,
    workspaceId: o.workspaceId,
    cloudPath: o.cloudPath,
    lastSync,
    localHash,
    syncStatus: normSyncStatus(o.syncStatus),
  };
}

function sanitizeImportedPathMapping(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const kk = k.trim();
    if (!kk || typeof v !== "string") {
      continue;
    }
    const vv = v.trim();
    if (vv.length > 0) {
      out[kk] = vv;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Разбор JSON файла структуры (экспорт или совместимый объект). Без UI. */
export function parseWorkspaceStructureImport(data: unknown): WorkspaceConfig {
  if (data === null || typeof data !== "object") {
    throw new Error("неверный JSON");
  }
  const o = data as Record<string, unknown>;
  if (o.schema === WORKSPACE_STRUCTURE_LITE_SCHEMA) {
    throw new Error(
      "это портативная структура (schema 2) — команда Import обработает её через облако; полное восстановление кэша не применимо",
    );
  }
  if (typeof o.schema === "number" && o.schema !== EXPORT_SCHEMA) {
    throw new Error(`неподдерживаемая schema: ${String(o.schema)}`);
  }
  if (!Array.isArray(o.activeWorkspaces) || !Array.isArray(o.files)) {
    throw new Error("нужны массивы activeWorkspaces и files");
  }
  const pm = sanitizeImportedPathMapping(o.pathMapping);
  return {
    activeWorkspaces: o.activeWorkspaces.map((e, i) => parseActiveEntry(e, i)),
    files: o.files.map((e, i) => parseTrackedFile(e, i)),
    ...(pm !== undefined ? { pathMapping: pm } : {}),
  };
}

export const WORKSPACE_STRUCTURE_EXPORT_SCHEMA = EXPORT_SCHEMA;
export { EXPORT_SCHEMA as WORKSPACE_STRUCTURE_FULL_EXPORT_SCHEMA };
