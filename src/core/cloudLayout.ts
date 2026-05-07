import type { ProviderType } from "./types.js";

/** Корневая папка на облаке (OneDrive / mock). */
export const CLOUD_ROOT_DIR = "VSCodeSyncFiles";

export function workspaceRootPath(workspaceId: string): string {
  return `${CLOUD_ROOT_DIR}/${workspaceId}`;
}

export function manifestCloudPath(workspaceId: string): string {
  return `${workspaceRootPath(workspaceId)}/.vscodesync-workspace.json`;
}

export function metaCloudPath(workspaceId: string): string {
  return `${workspaceRootPath(workspaceId)}/_meta.json`;
}

/** Глобальный реестр машин на облаке (см. docs/v1/02-core-sync/manifest-protocol.md). */
export function machinesRegistryCloudPath(): string {
  return `${CLOUD_ROOT_DIR}/_machines.json`;
}

export function historyDirForFile(workspaceId: string, posixFilePath: string): string {
  const safe = posixFilePath.replace(/^\//, "");
  return `${workspaceRootPath(workspaceId)}/.history/${safe}`;
}

export function trackedFileCloudPath(workspaceId: string, posixFilePath: string): string {
  const safe = posixFilePath.replace(/^\//, "");
  return `${workspaceRootPath(workspaceId)}/${safe}`;
}

export const SUPPORTED_MANIFEST_SCHEMA = 1 as const;

export interface CloudManifest {
  schemaVersion: typeof SUPPORTED_MANIFEST_SCHEMA;
  workspaceId: string;
  workspaceNote: string;
  tags: string[];
  gitBranch?: string;
  /** May be missing in older `.vscodesync-workspace.json` on disk; always coerce after `JSON.parse`. */
  sharedIgnorePatterns?: string[];
  providerType: ProviderType;
  createdAt: string;
  updatedAt: string;
  machines: MachineEntry[];
  files: ManifestFile[];
}

/** Safe read for ignore patterns (absent in legacy manifests). */
export function sharedIgnorePatternsOrEmpty(m: CloudManifest): string[] {
  const v = m.sharedIgnorePatterns;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface ManifestFile {
  path: string;
  addedAt: string;
  version: number;
  removedAt?: string;
  renamedFrom?: string;
  renamedAt?: string;
  hasSyncignoreMarkers: boolean;
  editingBy?: string;
  editingSince?: string;
}

export interface MachineEntry {
  machineId: string;
  machineName: string;
  lastSeen: string;
  status?: "active" | "pending" | "blocked";
}

export interface MetaJson {
  files: Partial<Record<string, MetaEntry>>;
}

export interface MetaEntry {
  hash: string;
  etag: string;
  version: number;
  machineId: string;
  updatedAt: string;
  /**
   * When true: cloud blob bytes are gzip(plaintext-canonical UTF-8) before optional encryption wrapper.
   * Hash in `hash` stays canonical plaintext (post line-ending/syncignore hashing rules).
   */
  wireGzip?: boolean;
  /**
   * v2.3 (planned): cloud blob bytes are zstd-compressed via WASM backend.
   * Mutually exclusive with wireGzip — at most one wire codec per file.
   * Off-by-default; readers fall back gracefully when codec is unknown.
   */
  wireZstd?: boolean;
}

export const EMPTY_META_JSON: MetaJson = { files: {} };

export const SNAPSHOT_META_NAME = ".snapshot-meta.json";

export function snapshotsDirForWorkspace(workspaceId: string): string {
  return `${workspaceRootPath(workspaceId)}/.snapshots`;
}

export function snapshotDirPath(workspaceId: string, snapshotName: string): string {
  return `${snapshotsDirForWorkspace(workspaceId)}/${snapshotName}`;
}

export function snapshotMetaCloudPath(workspaceId: string, snapshotName: string): string {
  return `${snapshotDirPath(workspaceId, snapshotName)}/${SNAPSHOT_META_NAME}`;
}

export function snapshotFilePath(workspaceId: string, snapshotName: string, posixRel: string): string {
  const safe = posixRel.replace(/^\/+/, "");
  return `${snapshotDirPath(workspaceId, snapshotName)}/${safe}`;
}

export interface SnapshotMeta {
  schemaVersion: 1;
  name: string;
  createdAt: string;
  machineName: string;
  files: string[];
}
