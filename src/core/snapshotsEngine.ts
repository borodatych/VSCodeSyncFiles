import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import type { SnapshotMeta } from "./cloudLayout.js";
import {
  SNAPSHOT_META_NAME,
  snapshotsDirForWorkspace,
  snapshotDirPath,
  snapshotMetaCloudPath,
  snapshotFilePath,
} from "./cloudLayout.js";
import type { WorkspaceConfig } from "./types.js";
import { WorkspaceConfigManager } from "./workspaceConfigManager.js";
import { trackedLocalAbsolutePath } from "./pathMapping.js";

export interface SnapshotEntry {
  name: string;
  meta: SnapshotMeta;
}

export type SnapshotCategory = "user" | "system";

export interface SnapshotInfo {
  name: string;
  meta: SnapshotMeta;
  category: SnapshotCategory;
}

function categorize(name: string): SnapshotCategory {
  return name.startsWith("auto-") || name.startsWith("pre-migration-") ? "system" : "user";
}

function safeName(raw: string): string {
  return raw
    .trim()
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 200);
}

function getFirstSegment(prefix: string, items: { cloudPath: string }[]): Set<string> {
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const segs = new Set<string>();
  for (const it of items) {
    if (!it.cloudPath.startsWith(base)) {
      continue;
    }
    const rest = it.cloudPath.slice(base.length);
    const seg = rest.split("/")[0];
    if (seg && seg !== SNAPSHOT_META_NAME) {
      segs.add(seg);
    }
  }
  return segs;
}

function parseSnapshotMeta(raw: string): SnapshotMeta | null {
  try {
    const m = JSON.parse(raw) as {
      schemaVersion?: number;
      name?: string;
      createdAt?: string;
      machineName?: string;
      files?: unknown;
    };
    if (
      m.schemaVersion !== 1 ||
      typeof m.name !== "string" ||
      typeof m.createdAt !== "string" ||
      typeof m.machineName !== "string"
    ) {
      return null;
    }
    const files = Array.isArray(m.files) ? (m.files as string[]).filter((f) => typeof f === "string") : [];
    return { schemaVersion: 1, name: m.name, createdAt: m.createdAt, machineName: m.machineName, files };
  } catch {
    return null;
  }
}

export async function listWorkspaceSnapshots(
  provider: ICloudProvider,
  workspaceId: string,
): Promise<SnapshotInfo[]> {
  const dir = snapshotsDirForWorkspace(workspaceId);
  let listed: { cloudPath: string }[];
  try {
    listed = await provider.listFolder(dir);
  } catch {
    return [];
  }
  const names = getFirstSegment(dir, listed);
  const out: SnapshotInfo[] = [];
  for (const name of names) {
    try {
      const dl = await provider.downloadFile(snapshotMetaCloudPath(workspaceId, name));
      const meta = parseSnapshotMeta(dl.body.toString("utf8"));
      if (!meta) {
        continue;
      }
      out.push({ name, meta, category: categorize(name) });
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        continue;
      }
      throw e;
    }
  }
  out.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
  return out;
}

export async function createWorkspaceSnapshot(
  provider: ICloudProvider,
  workspaceRoot: string,
  workspaceId: string,
  nameRaw: string,
  machineName: string,
): Promise<string> {
  const name = safeName(nameRaw);
  if (!name) {
    throw new Error("Имя снапшота не может быть пустым");
  }

  const cfg: WorkspaceConfig = await WorkspaceConfigManager.load(workspaceRoot);
  const trackedFiles = cfg.files.filter((f) => f.workspaceId === workspaceId && !f.syncStatus?.includes("removed"));

  const uploadedPaths: string[] = [];
  for (const f of trackedFiles) {
    const abs = trackedLocalAbsolutePath(workspaceRoot, cfg.pathMapping, machineName, f.localPath);
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      continue;
    }
    const destCloud = snapshotFilePath(workspaceId, name, f.localPath);
    await provider.uploadFile(destCloud, buf);
    uploadedPaths.push(f.localPath);
  }

  const meta: SnapshotMeta = {
    schemaVersion: 1,
    name,
    createdAt: new Date().toISOString(),
    machineName,
    files: uploadedPaths,
  };
  const metaBody = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await provider.uploadFile(snapshotMetaCloudPath(workspaceId, name), metaBody);

  return name;
}

export async function deleteWorkspaceSnapshot(
  provider: ICloudProvider,
  workspaceId: string,
  snapshotName: string,
): Promise<void> {
  const dir = snapshotDirPath(workspaceId, snapshotName);
  let items: { cloudPath: string }[];
  try {
    items = await provider.listFolder(dir);
  } catch {
    items = [];
  }
  for (const it of items) {
    try {
      await provider.deleteFile(it.cloudPath);
    } catch {
      /* best-effort */
    }
  }
  try {
    await provider.deleteFile(snapshotMetaCloudPath(workspaceId, snapshotName));
  } catch {
    /* best-effort */
  }
}

export async function restoreWorkspaceSnapshot(
  provider: ICloudProvider,
  workspaceRoot: string,
  workspaceId: string,
  snapshotName: string,
  machineName: string,
): Promise<{ restoredCount: number }> {
  const cfg = await WorkspaceConfigManager.load(workspaceRoot);
  const metaDl = await provider.downloadFile(snapshotMetaCloudPath(workspaceId, snapshotName));
  const meta = parseSnapshotMeta(metaDl.body.toString("utf8"));
  if (!meta) {
    throw new Error("Повреждённый .snapshot-meta.json");
  }

  let count = 0;
  for (const posixRel of meta.files) {
    const cloudPath = snapshotFilePath(workspaceId, snapshotName, posixRel);
    try {
      const dl = await provider.downloadFile(cloudPath);
      const abs = trackedLocalAbsolutePath(workspaceRoot, cfg.pathMapping, machineName, posixRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, dl.body);
      count += 1;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        continue;
      }
      throw e;
    }
  }
  return { restoredCount: count };
}
