import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { CLOUD_ROOT_DIR } from "./cloudLayout.js";
import type { FileMetadata, ICloudProvider } from "../providers/cloudProviderTypes.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import { WorkspaceConfigManager } from "./workspaceConfigManager.js";
import { trackedLocalAbsolutePath } from "./pathMapping.js";
import { rejectIfSecondaryWorkspaceInstanceReadOnly } from "./syncWorkspaceInstanceReadOnly.js";
import { backupExistingUserFile } from "./localFileBackup.js";
import { writeFileAtomic } from "./writeTextFileAtomic.js";

export const QUICK_TRANSFER_ROOT = `${CLOUD_ROOT_DIR}/_quicktransfer`;

export const QUICK_TRANSFER_PAYLOAD_NAME = "payload";

export const QUICK_TRANSFER_SCHEMA = 1 as const;

export interface QuickTransferMeta {
  schemaVersion: typeof QUICK_TRANSFER_SCHEMA;
  transferId: string;
  fromMachineId: string;
  fromMachineName: string;
  sentAt: string;
  /** Относительный путь от корня папки workspace (POSIX, без ..). */
  relativePath: string;
  targetMachineId?: string;
  ttlDays: number;
}

export function quickTransferFolder(transferId: string): string {
  return `${QUICK_TRANSFER_ROOT}/${transferId}`;
}

export function quickTransferMetaPath(transferId: string): string {
  return `${quickTransferFolder(transferId)}/.transfer-meta.json`;
}

export function quickTransferPayloadPath(transferId: string): string {
  return `${quickTransferFolder(transferId)}/${QUICK_TRANSFER_PAYLOAD_NAME}`;
}

/** Первый сегмент пути под префиксом (поддержка mock listFolder с вложенными ключами). */
export function childFolderIdsUnderPrefix(prefix: string, items: FileMetadata[]): string[] {
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const ids = new Set<string>();
  for (const it of items) {
    if (!it.cloudPath.startsWith(base)) {
      continue;
    }
    const rest = it.cloudPath.slice(base.length);
    const seg = rest.split("/")[0];
    if (!seg || seg.includes(".")) {
      continue;
    }
    ids.add(seg);
  }
  return [...ids];
}

export function safePosixRelative(rel: string): string | null {
  const norm = rel.trim().replace(/\\/g, "/");
  const parts = norm.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) {
    return null;
  }
  if (parts.some((p) => p === "..")) {
    return null;
  }
  return parts.join("/");
}

export function quickTransferExpiresAtIso(meta: QuickTransferMeta): string {
  const d = new Date(meta.sentAt);
  d.setUTCDate(d.getUTCDate() + meta.ttlDays);
  return d.toISOString();
}

/** UTC date + ttlDays — same rule as meta in cloud (for offline-queue TTL before flush). */
export function quickTransferExpiryMs(sentAtIso: string, ttlDays: number): number {
  const d = new Date(sentAtIso);
  d.setUTCDate(d.getUTCDate() + ttlDays);
  return d.getTime();
}

export function isQuickTransferExpired(meta: QuickTransferMeta, nowMs = Date.now()): boolean {
  return quickTransferExpiryMs(meta.sentAt, meta.ttlDays) < nowMs;
}

export function isQueuedQuickTransferSendExpired(queuedAtIso: string, ttlDays: number, nowMs = Date.now()): boolean {
  return quickTransferExpiryMs(queuedAtIso, ttlDays) < nowMs;
}

export interface SendQuickTransferResult {
  transferId: string;
  expiresAtIso: string;
}

export async function sendQuickTransferFile(
  provider: ICloudProvider,
  opts: {
    machineId: string;
    machineName: string;
    ttlDays: number;
    absolutePath: string;
    projectRelativePosix: string;
    targetMachineId?: string;
    maxFileSizeBytes?: number;
  },
): Promise<SendQuickTransferResult> {
  rejectIfSecondaryWorkspaceInstanceReadOnly();
  const relSafe = safePosixRelative(opts.projectRelativePosix);
  if (!relSafe) {
    throw new Error("Некорректный относительный путь файла");
  }
  const buf = await fs.readFile(opts.absolutePath);
  if (opts.maxFileSizeBytes !== undefined && opts.maxFileSizeBytes > 0 && buf.length > opts.maxFileSizeBytes) {
    throw new Error(
      `Файл больше лимита Quick Transfer (${String(buf.length)} B > ${String(opts.maxFileSizeBytes)} B)`,
    );
  }
  const transferId = randomBytes(16).toString("hex");
  const sentAt = new Date().toISOString();
  const meta: QuickTransferMeta = {
    schemaVersion: QUICK_TRANSFER_SCHEMA,
    transferId,
    fromMachineId: opts.machineId,
    fromMachineName: opts.machineName,
    sentAt,
    relativePath: relSafe,
    ttlDays: Math.max(1, opts.ttlDays),
    targetMachineId: opts.targetMachineId,
  };
  const metaBody = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await provider.uploadFile(quickTransferPayloadPath(transferId), buf);
  await provider.uploadFile(quickTransferMetaPath(transferId), metaBody);
  return { transferId, expiresAtIso: quickTransferExpiresAtIso(meta) };
}

export interface IncomingQuickTransfer {
  transferId: string;
  meta: QuickTransferMeta;
}

function parseMetaBody(raw: string): QuickTransferMeta | null {
  try {
    const m = JSON.parse(raw) as {
      schemaVersion?: number;
      transferId?: string;
      fromMachineId?: string;
      fromMachineName?: string;
      sentAt?: string;
      relativePath?: string;
      targetMachineId?: string;
      ttlDays?: number;
    };
    if (m.schemaVersion !== QUICK_TRANSFER_SCHEMA || typeof m.transferId !== "string") {
      return null;
    }
    if (
      typeof m.fromMachineId !== "string" ||
      typeof m.fromMachineName !== "string" ||
      typeof m.sentAt !== "string" ||
      typeof m.relativePath !== "string"
    ) {
      return null;
    }
    const ttl = typeof m.ttlDays === "number" && Number.isFinite(m.ttlDays) ? m.ttlDays : 7;
    return {
      schemaVersion: QUICK_TRANSFER_SCHEMA,
      transferId: m.transferId,
      fromMachineId: m.fromMachineId,
      fromMachineName: m.fromMachineName,
      sentAt: m.sentAt,
      relativePath: m.relativePath,
      targetMachineId: m.targetMachineId,
      ttlDays: ttl,
    };
  } catch {
    return null;
  }
}

export async function purgeExpiredQuickTransferPackages(provider: ICloudProvider): Promise<void> {
  const listed = await provider.listFolder(QUICK_TRANSFER_ROOT);
  const ids = childFolderIdsUnderPrefix(QUICK_TRANSFER_ROOT, listed);
  for (const id of ids) {
    try {
      const dl = await provider.downloadFile(quickTransferMetaPath(id));
      const meta = parseMetaBody(dl.body.toString("utf8"));
      if (!meta) {
        continue;
      }
      if (isQuickTransferExpired(meta)) {
        await deleteQuickTransferPackage(provider, id);
      }
    } catch {
      /* некорректный пакет при очистке — пропускаем */
    }
  }
}

export async function listIncomingQuickTransfers(
  provider: ICloudProvider,
  myMachineId: string,
): Promise<IncomingQuickTransfer[]> {
  await purgeExpiredQuickTransferPackages(provider);
  const listed = await provider.listFolder(QUICK_TRANSFER_ROOT);
  const ids = childFolderIdsUnderPrefix(QUICK_TRANSFER_ROOT, listed);
  const out: IncomingQuickTransfer[] = [];
  for (const id of ids) {
    try {
      const dl = await provider.downloadFile(quickTransferMetaPath(id));
      const meta = parseMetaBody(dl.body.toString("utf8"));
      if (meta?.transferId !== id) {
        continue;
      }
      if (isQuickTransferExpired(meta)) {
        await deleteQuickTransferPackage(provider, id);
        continue;
      }
      if (meta.fromMachineId === myMachineId) {
        continue;
      }
      if (meta.targetMachineId !== undefined && meta.targetMachineId !== "" && meta.targetMachineId !== myMachineId) {
        continue;
      }
      try {
        await provider.downloadFile(quickTransferPayloadPath(id));
      } catch (e) {
        if (e instanceof ProviderError && e.code === "NOT_FOUND") {
          continue;
        }
        throw e;
      }
      out.push({ transferId: id, meta });
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        continue;
      }
      throw e;
    }
  }
  return out;
}

export async function deleteQuickTransferPackage(provider: ICloudProvider, transferId: string): Promise<void> {
  const tryDel = async (p: string): Promise<void> => {
    try {
      await provider.deleteFile(p);
    } catch {
      /* best-effort */
    }
  };
  const folder = quickTransferFolder(transferId);
  const listed = await provider.listFolder(folder);
  for (const it of listed) {
    await tryDel(it.cloudPath);
  }
  await tryDel(quickTransferMetaPath(transferId));
  await tryDel(quickTransferPayloadPath(transferId));
}

/**
 * Everything needed to decide *how* to land an incoming package, with nothing
 * written to disk yet. The receive flow used to be a single call that silently
 * overwrote an existing local file and deleted the cloud package regardless of
 * the outcome (D7); the decision now belongs to the caller.
 */
export interface PreparedQuickTransfer {
  transferId: string;
  meta: QuickTransferMeta;
  /** Normalised POSIX path relative to the workspace root. */
  relSafe: string;
  destAbs: string;
  destExists: boolean;
  body: Buffer;
}

export type QuickTransferApplyMode = "overwrite" | "side-by-side";

export async function prepareQuickTransferReceive(
  provider: ICloudProvider,
  transferId: string,
  workspaceRoot: string,
  machineName: string,
): Promise<PreparedQuickTransfer> {
  const metaDl = await provider.downloadFile(quickTransferMetaPath(transferId));
  const meta = parseMetaBody(metaDl.body.toString("utf8"));
  if (!meta) {
    throw new Error("Повреждённый .transfer-meta.json");
  }
  if (isQuickTransferExpired(meta)) {
    await deleteQuickTransferPackage(provider, transferId);
    throw new Error("Срок Quick Transfer истёк");
  }
  const safe = safePosixRelative(meta.relativePath);
  if (!safe) {
    throw new Error("Некорректный relativePath в метаданных");
  }
  const cfg = await WorkspaceConfigManager.load(workspaceRoot);
  const body = await provider.downloadFile(quickTransferPayloadPath(transferId));
  const destAbs = trackedLocalAbsolutePath(workspaceRoot, cfg.pathMapping, machineName, safe);
  let destExists = true;
  try {
    await fs.access(destAbs);
  } catch {
    destExists = false;
  }
  return { transferId, meta, relSafe: safe, destAbs, destExists, body: body.body };
}

/**
 * Build the side-by-side name for an existing destination: the timestamp goes
 * before the extension so the editor still recognises the file type.
 */
export function quickTransferSideBySidePath(destAbs: string, nowMs = Date.now()): string {
  const stamp = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  const ext = path.extname(destAbs);
  const base = ext === "" ? destAbs : destAbs.slice(0, -ext.length);
  return `${base}.incoming-${stamp}${ext}`;
}

/**
 * Write the prepared package to disk and only then drop the cloud package —
 * a failed write used to lose the file on both sides.
 */
export async function applyQuickTransferReceive(
  provider: ICloudProvider,
  prepared: PreparedQuickTransfer,
  mode: QuickTransferApplyMode,
  opts: {
    workspaceRoot: string;
    /** Omit to skip the pre-overwrite copy (`localBackupEnabled: false`). */
    backup?: { retentionDays?: number; backupDir?: string };
  },
): Promise<{ savedTo: string }> {
  const target =
    mode === "side-by-side" ? quickTransferSideBySidePath(prepared.destAbs) : prepared.destAbs;
  if (mode === "overwrite" && prepared.destExists && opts.backup) {
    await backupExistingUserFile({
      absPath: prepared.destAbs,
      workspaceRoot: opts.workspaceRoot,
      posixRel: prepared.relSafe,
      retentionDays: opts.backup.retentionDays,
      backupDir: opts.backup.backupDir,
    });
  }
  await writeFileAtomic(target, prepared.body);
  await deleteQuickTransferPackage(provider, prepared.transferId);
  // Derive the reported path from the tracked posix path, not from the absolute
  // one: under a `pathMapping` the two differ, and the user thinks in the former.
  const segments = prepared.relSafe.split("/");
  segments[segments.length - 1] = path.basename(target);
  return { savedTo: segments.join("/") };
}
