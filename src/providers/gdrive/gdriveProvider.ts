import type { SecretStore } from "../../core/types.js";
import type { ProviderType } from "../../core/types.js";
import { CLOUD_ROOT_DIR } from "../../core/cloudLayout.js";
import type {
  DownloadOptions,
  DownloadResult,
  FileMetadata,
  ICloudProvider,
  UploadOptions,
  UploadResult,
} from "../cloudProviderTypes.js";
import { ProviderError } from "../cloudProviderTypes.js";
import {
  noteProviderRateLimited,
  noteProviderRequestSuccess,
} from "../../core/syncRateLimitState.js";
import { parseRetryAfterToDelayMs } from "../../utils/retryAfter.js";
import { bumpOfflineFlushBackoff } from "../../core/syncOfflineFlushBackoff.js";
import {
  noteCloudTransportFailure,
  noteCloudTransportSuccess,
} from "../../core/syncOfflineHints.js";
import {
  clearGdriveTokens,
  readGdriveTokens,
  storeGdriveTokens,
  type GdriveTokenBundle,
} from "./gdriveTokens.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const MIME_FOLDER = "application/vnd.google-apps.folder";

function escapeDriveQueryLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeEtag(h: string | null | undefined): string | undefined {
  if (!h) {
    return undefined;
  }
  return h.replace(/^"+|"+$/g, "");
}

interface DriveFileSummary {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  etag?: string;
}

function buildMultipartRelated(metadata: object, content: Buffer, boundary: string): Buffer {
  const p1 = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const p2 = `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const p3 = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(p1, "utf8"), Buffer.from(p2, "utf8"), content, Buffer.from(p3, "utf8")]);
}

export class GdriveProvider implements ICloudProvider {
  readonly type: ProviderType = "gdrive";

  constructor(
    private readonly secrets: SecretStore,
    private readonly getGoogleClientId: () => string,
  ) {}

  async isAuthenticated(): Promise<boolean> {
    const t = await readGdriveTokens(this.secrets);
    return !!t?.accessToken;
  }

  async authenticate(): Promise<void> {
    await Promise.resolve();
    throw new Error("Use VSCodeSync: Sign in to Google Drive");
  }

  async logout(): Promise<void> {
    await clearGdriveTokens(this.secrets);
  }

  private async refreshAccessToken(refreshToken: string): Promise<GdriveTokenBundle> {
    const clientId = this.getGoogleClientId();
    if (!clientId) {
      throw new ProviderError("UNAUTHORIZED", "Google Drive: задайте vscodesync.googleDriveClientId.");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) {
      throw new ProviderError("UNAUTHORIZED", await r.text());
    }
    const j = (await r.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    const rt = j.refresh_token ?? refreshToken;
    const expiresAtMs = Date.now() + j.expires_in * 1000;
    const bundle: GdriveTokenBundle = {
      accessToken: j.access_token,
      refreshToken: rt,
      expiresAtMs,
    };
    await storeGdriveTokens(this.secrets, bundle);
    return bundle;
  }

  private async accessToken(): Promise<string> {
    let bundle = await readGdriveTokens(this.secrets);
    if (!bundle?.accessToken) {
      throw new ProviderError("UNAUTHORIZED", "Google Drive: нет токена. Выполните вход.");
    }
    const skewMs = 5 * 60 * 1000;
    if (bundle.expiresAtMs - Date.now() < skewMs && bundle.refreshToken) {
      bundle = await this.refreshAccessToken(bundle.refreshToken);
    }
    return bundle.accessToken;
  }

  private async driveFetch(url: string, init?: RequestInit): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(url, init);
    } catch (e) {
      bumpOfflineFlushBackoff();
      noteCloudTransportFailure();
      throw new ProviderError("NETWORK_ERROR", e instanceof Error ? e.message : String(e), { cause: e });
    }
    if (r.status === 429 || r.status === 503) {
      const ra = parseRetryAfterToDelayMs(r.headers.get("Retry-After"));
      noteProviderRateLimited(ra);
      throw new ProviderError("RATE_LIMITED", `Google Drive throttled (${String(r.status)})`, {
        retryAfterMs: ra,
      });
    }
    if (r.ok || r.status === 304) {
      noteProviderRequestSuccess();
      noteCloudTransportSuccess();
    }
    return r;
  }

  private async getRootFolderId(token: string): Promise<string> {
    const name = escapeDriveQueryLiteral(CLOUD_ROOT_DIR);
    const q = `name='${name}' and 'root' in parents and mimeType='${MIME_FOLDER}' and trashed=false`;
    const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`;
    const r = await this.driveFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const j = (await r.json()) as { files?: { id?: string }[] };
    const existing = j.files?.[0]?.id;
    if (existing) {
      return existing;
    }
    const create = await this.driveFetch(`${DRIVE}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: CLOUD_ROOT_DIR,
        mimeType: MIME_FOLDER,
        parents: ["root"],
      }),
    });
    if (!create.ok) {
      throw new ProviderError("NETWORK_ERROR", await create.text());
    }
    const created = (await create.json()) as { id?: string };
    if (!created.id) {
      throw new ProviderError("NETWORK_ERROR", "Google Drive: не удалось создать корневую папку");
    }
    return created.id;
  }

  /**
   * Resolve a file path under VSCodeSyncFiles/ — returns parent folder id, matching item (if any), leaf name.
   */
  private async resolveLeaf(
    token: string,
    cloudPath: string,
  ): Promise<{ parentId: string; item: DriveFileSummary | null; filename: string }> {
    const segments = cloudPath.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== CLOUD_ROOT_DIR) {
      throw new ProviderError("NETWORK_ERROR", `Invalid cloud path: ${cloudPath}`);
    }
    let parentId = await this.getRootFolderId(token);
    for (let i = 1; i < segments.length - 1; i += 1) {
      parentId = await this.ensureChildFolder(token, parentId, segments[i] ?? "");
    }
    const filename = segments[segments.length - 1] ?? "";
    const item = await this.findChild(token, parentId, filename);
    return { parentId, item, filename };
  }

  private async ensureFolderPath(token: string, cloudPath: string): Promise<string> {
    const trimmed = cloudPath.endsWith("/") ? cloudPath.slice(0, -1) : cloudPath;
    const segments = trimmed.split("/").filter(Boolean);
    if (segments.length < 1 || segments[0] !== CLOUD_ROOT_DIR) {
      throw new ProviderError("NETWORK_ERROR", `Invalid folder path: ${cloudPath}`);
    }
    let parentId = await this.getRootFolderId(token);
    for (let i = 1; i < segments.length; i += 1) {
      parentId = await this.ensureChildFolder(token, parentId, segments[i] ?? "");
    }
    return parentId;
  }

  private async findChild(token: string, parentId: string, name: string): Promise<DriveFileSummary | null> {
    const n = escapeDriveQueryLiteral(name);
    const q = `name='${n}' and '${parentId}' in parents and trashed=false`;
    const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,md5Checksum,modifiedTime)&pageSize=20`;
    const r = await this.driveFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const j = (await r.json()) as { files?: DriveFileSummary[] };
    const files = j.files ?? [];
    return files[0] ?? null;
  }

  private async ensureChildFolder(token: string, parentId: string, name: string): Promise<string> {
    const existing = await this.findChild(token, parentId, name);
    if (existing?.mimeType === MIME_FOLDER) {
      return existing.id;
    }
    if (existing && existing.mimeType !== MIME_FOLDER) {
      throw new ProviderError("NETWORK_ERROR", `Google Drive: ожидалась папка, найден файл: ${name}`);
    }
    const r = await this.driveFetch(`${DRIVE}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: MIME_FOLDER,
        parents: [parentId],
      }),
    });
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const created = (await r.json()) as { id?: string };
    if (!created.id) {
      throw new ProviderError("NETWORK_ERROR", "Google Drive: mkdir failed");
    }
    return created.id;
  }

  async uploadFile(cloudPath: string, content: Buffer, options?: UploadOptions): Promise<UploadResult> {
    const token = await this.accessToken();
    const segments = cloudPath.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== CLOUD_ROOT_DIR) {
      throw new ProviderError("NETWORK_ERROR", `Invalid path: ${cloudPath}`);
    }
    let parentId = await this.getRootFolderId(token);
    for (let i = 1; i < segments.length - 1; i += 1) {
      parentId = await this.ensureChildFolder(token, parentId, segments[i] ?? "");
    }
    const filename = segments[segments.length - 1] ?? "";
    const existing = await this.findChild(token, parentId, filename);

    if (existing?.mimeType === MIME_FOLDER) {
      throw new ProviderError("NETWORK_ERROR", "Target path is a folder");
    }

    if (existing?.id) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      };
      if (options?.ifMatch) {
        headers["If-Match"] = options.ifMatch;
      }
      const r = await this.driveFetch(`${UPLOAD}/files/${existing.id}?uploadType=media`, {
        method: "PATCH",
        headers,
        body: new Uint8Array(content),
      });
      if (r.status === 412) {
        throw new ProviderError("PRECONDITION_FAILED", "If-Match failed on Google Drive");
      }
      if (!r.ok) {
        throw new ProviderError("NETWORK_ERROR", await r.text());
      }
      const etag = normalizeEtag(r.headers.get("etag"));
      return { etag };
    }

    const boundary = `batch_${String(Math.random()).slice(2)}`;
    const meta = { name: filename, parents: [parentId] };
    const body = buildMultipartRelated(meta, content, boundary);

    const r = await this.driveFetch(`${UPLOAD}/files?uploadType=multipart`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const etagHdr = normalizeEtag(r.headers.get("etag"));
    const created = (await r.json()) as { md5Checksum?: string; etag?: string };
    return { etag: etagHdr ?? normalizeEtag(created.etag ?? created.md5Checksum ?? null) };
  }

  async downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    const token = await this.accessToken();
    const { item } = await this.resolveLeaf(token, cloudPath);
    if (!item?.id || item.mimeType === MIME_FOLDER) {
      throw new ProviderError("NOT_FOUND", cloudPath);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (options?.ifNoneMatch) {
      headers["If-None-Match"] = options.ifNoneMatch;
    }
    const r = await this.driveFetch(`${DRIVE}/files/${item.id}?alt=media`, { headers });
    if (r.status === 304) {
      return {
        body: Buffer.alloc(0),
        etag: options?.ifNoneMatch,
        notModified: true,
      };
    }
    if (r.status === 404) {
      throw new ProviderError("NOT_FOUND", cloudPath);
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const etag =
      normalizeEtag(r.headers.get("etag")) ??
      normalizeEtag(item.md5Checksum ?? null) ??
      item.md5Checksum;
    return { body: buf, etag };
  }

  async getMetadata(cloudPath: string): Promise<FileMetadata | null> {
    const token = await this.accessToken();
    const { item } = await this.resolveLeaf(token, cloudPath);
    if (!item?.id) {
      return null;
    }
    const r = await this.driveFetch(
      `${DRIVE}/files/${item.id}?fields=id,name,size,md5Checksum,modifiedTime,mimeType`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (r.status === 404) {
      return null;
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const meta = (await r.json()) as DriveFileSummary;
    const etag = normalizeEtag(meta.md5Checksum ?? meta.etag ?? null);
    const sizeNum = meta.size != null ? Number(meta.size) : undefined;
    return {
      cloudPath,
      size: Number.isFinite(sizeNum) ? sizeNum : undefined,
      etag,
      modifiedIso: meta.modifiedTime,
    };
  }

  async deleteFile(cloudPath: string): Promise<void> {
    const token = await this.accessToken();
    const { item } = await this.resolveLeaf(token, cloudPath);
    if (!item?.id) {
      return;
    }
    const r = await this.driveFetch(`${DRIVE}/files/${item.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404) {
      return;
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
  }

  async listFolder(cloudPath: string): Promise<FileMetadata[]> {
    const token = await this.accessToken();
    const folderPath = cloudPath.endsWith("/") ? cloudPath.slice(0, -1) : cloudPath;
    const folderId = await this.ensureFolderPath(token, folderPath);
    const q = `'${folderId}' in parents and trashed=false`;
    const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,md5Checksum,modifiedTime,mimeType)&pageSize=1000`;
    const r = await this.driveFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) {
      return [];
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const j = (await r.json()) as { files?: DriveFileSummary[] };
    const prefix = cloudPath.endsWith("/") ? cloudPath : `${cloudPath}/`;
    const rows = j.files ?? [];
    return rows.map((it) => {
      const subPath = `${prefix}${it.name}`;
      const etag = normalizeEtag(it.md5Checksum ?? it.etag);
      const sizeNum = it.size != null ? Number(it.size) : undefined;
      return {
        cloudPath: subPath,
        size: Number.isFinite(sizeNum) ? sizeNum : undefined,
        etag,
        modifiedIso: it.modifiedTime,
      };
    });
  }

  async createFolder(cloudPath: string): Promise<void> {
    const token = await this.accessToken();
    await this.ensureFolderPath(token, cloudPath);
  }

  async getWebViewLink(cloudPath: string): Promise<string | null> {
    const token = await this.accessToken();
    const { item } = await this.resolveLeaf(token, cloudPath);
    if (!item?.id) {
      return null;
    }
    const r = await this.driveFetch(`${DRIVE}/files/${item.id}?fields=webViewLink`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404) {
      return null;
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const j = (await r.json()) as { webViewLink?: string };
    return j.webViewLink ?? null;
  }
}
