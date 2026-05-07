import { CLOUD_ROOT_DIR, SUPPORTED_MANIFEST_SCHEMA, manifestCloudPath, type CloudManifest } from "./cloudLayout.js";
import type { ProviderType } from "./types.js";
import type { FileMetadata, ICloudProvider } from "../providers/cloudProviderTypes.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import { childFolderIdsUnderPrefix } from "./quickTransfer.js";

const ROOT_PREFIX = `${CLOUD_ROOT_DIR}/`;

/** Detects automated pre-migration snapshots under VSCodeSyncFiles/.snapshots/pre-migration-… (excluded from export/backup). */
export function isPreMigrationArchivePath(cloudPath: string): boolean {
  return cloudPath.includes(`${CLOUD_ROOT_DIR}/.snapshots/pre-migration-`);
}

export function preMigrationSnapshotFolderBasename(): string {
  return `pre-migration-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Lists cloud paths for files (leaves) under folderPath using the same descend rule as SyncEngine.deleteCloudFolderRecursive.
 */
export async function collectLeafFilesUnderPrefix(
  provider: ICloudProvider,
  folderPath: string,
  opts?: { excludePreMigrationArchives?: boolean },
): Promise<string[]> {
  const excludePm = opts?.excludePreMigrationArchives ?? true;
  const out: string[] = [];
  const walk = async (dirPath: string): Promise<void> => {
    const asDir = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    let items: FileMetadata[];
    try {
      items = await provider.listFolder(asDir);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        return;
      }
      throw e;
    }
    for (const it of items) {
      const p = it.cloudPath;
      if (excludePm && isPreMigrationArchivePath(p)) {
        continue;
      }
      const childPrefix = p.endsWith("/") ? p : `${p}/`;
      let nested: FileMetadata[];
      try {
        nested = await provider.listFolder(childPrefix);
      } catch (e) {
        if (e instanceof ProviderError && e.code === "NOT_FOUND") {
          nested = [];
        } else {
          throw e;
        }
      }
      if (nested.length > 0) {
        await walk(p);
      } else {
        out.push(p);
      }
    }
  };
  const start = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  await walk(start);
  return out;
}

export async function copyCloudFileBetweenProviders(
  from: ICloudProvider,
  to: ICloudProvider,
  srcPath: string,
  destPath: string,
): Promise<void> {
  const dl = await from.downloadFile(srcPath);
  await to.uploadFile(destPath, dl.body);
}

/**
 * Full tree under {@link CLOUD_ROOT_DIR}, excluding pre-migration archive paths.
 */
export async function listExportableVsCodeSyncFiles(provider: ICloudProvider): Promise<string[]> {
  return collectLeafFilesUnderPrefix(provider, ROOT_PREFIX, { excludePreMigrationArchives: true });
}

export async function copyVsCodeSyncFilesToPreMigrationSnapshot(
  provider: ICloudProvider,
  snapshotBasename: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const paths = await listExportableVsCodeSyncFiles(provider);
  const backupBase = `${CLOUD_ROOT_DIR}/.snapshots/${snapshotBasename}`;
  let done = 0;
  const total = paths.length;
  for (const p of paths) {
    if (!p.startsWith(ROOT_PREFIX)) {
      continue;
    }
    const rel = p.slice(ROOT_PREFIX.length);
    const dest = `${backupBase}/${rel}`;
    await copyCloudFileBetweenProviders(provider, provider, p, dest);
    done += 1;
    onProgress?.(done, total);
  }
}

export async function copyVsCodeSyncTreeBetweenProviders(
  from: ICloudProvider,
  to: ICloudProvider,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const paths = await listExportableVsCodeSyncFiles(from);
  let done = 0;
  const total = paths.length;
  for (const p of paths) {
    await copyCloudFileBetweenProviders(from, to, p, p);
    done += 1;
    onProgress?.(done, total);
  }
  return paths.length;
}

/**
 * Depth-first delete under folderPath (direct children on Graph; mock may list flat descendants — safe).
 * Same algorithm as SyncEngine private folder delete — exported for migration cleanup on another provider instance.
 */
export async function deleteCloudFolderRecursive(provider: ICloudProvider, folderPath: string): Promise<void> {
  const asDir = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  let items: FileMetadata[];
  try {
    items = await provider.listFolder(asDir);
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
      nested = await provider.listFolder(childPrefix);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        nested = [];
      } else {
        throw e;
      }
    }
    if (nested.length > 0) {
      await deleteCloudFolderRecursive(provider, p);
    }
    try {
      await provider.deleteFile(p);
    } catch (e) {
      if (!(e instanceof ProviderError && e.code === "NOT_FOUND")) {
        throw e;
      }
    }
  }
}

/** Removes the entire {@link CLOUD_ROOT_DIR} tree on the given provider (including snapshots). Best-effort root folder delete. */
export async function deleteVsCodeSyncRootOnProvider(provider: ICloudProvider): Promise<void> {
  await deleteCloudFolderRecursive(provider, CLOUD_ROOT_DIR);
  try {
    await provider.deleteFile(CLOUD_ROOT_DIR);
  } catch (e) {
    if (!(e instanceof ProviderError && e.code === "NOT_FOUND")) {
      throw e;
    }
  }
}

export async function patchManifestProviderTypesOnProvider(
  provider: ICloudProvider,
  targetType: ProviderType,
): Promise<void> {
  let listed: FileMetadata[];
  try {
    listed = await provider.listFolder(ROOT_PREFIX);
  } catch (e) {
    if (e instanceof ProviderError && e.code === "NOT_FOUND") {
      return;
    }
    throw e;
  }
  const ids = childFolderIdsUnderPrefix(CLOUD_ROOT_DIR, listed).filter((id) => id !== "_quicktransfer");
  for (const id of ids) {
    const path = manifestCloudPath(id);
    let dl: Awaited<ReturnType<ICloudProvider["downloadFile"]>>;
    try {
      dl = await provider.downloadFile(path);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        continue;
      }
      throw e;
    }
    const raw: unknown = JSON.parse(dl.body.toString("utf8"));
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const probe = raw as { schemaVersion?: unknown; workspaceId?: unknown };
    if (probe.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA || probe.workspaceId !== id) {
      continue;
    }
    const m = raw as CloudManifest;
    m.providerType = targetType;
    m.updatedAt = new Date().toISOString();
    const body = Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
    await provider.uploadFile(path, body, dl.etag ? { ifMatch: dl.etag } : {});
  }
}
