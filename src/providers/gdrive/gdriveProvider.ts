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
import { classifyProviderHttpError } from "../_shared/classifyHttpError.js";
import {
  inspectProviderResponse,
  providerTransportError,
} from "../_shared/providerFetchOutcome.js";
import { createTokenStore, type TokenStore } from "../_shared/tokenStore.js";
import { sendWithForcedRefreshOn401 } from "../_shared/forcedRefreshFetch.js";
import {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_DATA_TIMEOUT_MS,
  fetchWithTimeout,
} from "../_shared/fetchWithTimeout.js";
import {
  clearGdriveTokens,
  readGdriveTokens,
  storeGdriveTokens,
  type GdriveTokenBundle,
} from "./gdriveTokens.js";
import {
  createGdriveFolderIdCache,
  type IGdriveFolderIdCache,
} from "../../core/gdriveFolderIdCache.js";
import { withRetry } from "../../core/withRetry.js";
import { warnLog } from "../../utils/log.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const MIME_FOLDER = "application/vnd.google-apps.folder";

function escapeDriveQueryLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Drive allows several files with the same name in one folder, and the API
 * returns them in no particular order (D12). Taking `files[0]` meant two
 * machines racing to create `_meta.json` could end up writing to one copy and
 * reading the other — and the folder-id cache made that choice sticky for the
 * whole session.
 *
 * The tie-break is the smallest id: an arbitrary rule, but a *stable* one, so
 * every machine converges on the same file.
 */
export function pickDriveDuplicate<T extends { id: string; name?: string }>(
  files: readonly T[],
  label: string,
): T | null {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0] ?? null;
  const sorted = [...files].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  warnLog(
    "gdrive",
    `duplicate name "${label}": ${String(files.length)} entries, using id ${sorted[0]?.id ?? "?"} — remove the extras in Google Drive`,
  );
  return sorted[0] ?? null;
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

  /**
   * v0.7 — folder id cache keyed by absolute path under the cloud root.
   * Default TTL is 10 min; host can override via `setFolderCacheTtl()` so
   * the `vscodesync.gdrive.folderCacheTtlSec` setting takes effect at
   * runtime without re-creating the provider.
   */
  private folderCache: IGdriveFolderIdCache = createGdriveFolderIdCache({ ttlMs: 10 * 60 * 1000 });

  /** Owns the SecretStorage key and the per-instance refresh mutex (E4/E14). */
  private readonly tokens: TokenStore<GdriveTokenBundle>;

  constructor(
    private readonly secrets: SecretStore,
    private readonly getGoogleClientId: () => string,
  ) {
    this.tokens = createTokenStore<GdriveTokenBundle>(secrets, "gdrive");
  }

  /** v0.7 — rebuild the folder cache with a new TTL (ms). 0 disables. */
  setFolderCacheTtl(ttlMs: number): void {
    this.folderCache = createGdriveFolderIdCache({ ttlMs });
  }

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

  /**
   * Serialised per provider instance (E4): the registry hands one instance to
   * every consumer and several background tasks start at once, so unsynchronised
   * refreshes raced to persist and the loser's bundle could already be revoked.
   */
  private async refreshAccessToken(refreshToken: string): Promise<GdriveTokenBundle> {
    return this.tokens.refreshOnce(() => this.performTokenRefresh(refreshToken));
  }

  private async performTokenRefresh(refreshToken: string): Promise<GdriveTokenBundle> {
    const clientId = this.getGoogleClientId();
    if (!clientId) {
      throw new ProviderError("UNAUTHORIZED", "Google Drive: задайте vscodesync.googleDriveClientId.");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    const r = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, { channel: "gdrive.fetch", timeoutMs: DEFAULT_API_TIMEOUT_MS });
    if (!r.ok) {
      // A token endpoint answers 400/401 for a dead grant but 5xx when it is
      // merely unwell; calling both UNAUTHORIZED would sign the user out over
      // a blip, so the status decides.
      throw await this.classifyResponse(r);
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

  /**
   * Force a refresh after a 401 — the stored expiry cannot see a grant that the
   * provider revoked server-side.
   */
  private async forceRefreshAccessToken(): Promise<string> {
    const bundle = await readGdriveTokens(this.secrets);
    if (!bundle?.refreshToken) {
      throw new ProviderError("UNAUTHORIZED", "Google Drive: сессия истекла. Выполните повторный вход.");
    }
    const refreshed = await this.refreshAccessToken(bundle.refreshToken);
    return refreshed.accessToken;
  }

  /**
   * Turn an error response into a typed {@link ProviderError} (E1).
   *
   * Every non-ok branch in this provider goes through here, so a revoked token
   * surfaces as UNAUTHORIZED — and reaches the "sign in again" dialog — instead
   * of NETWORK_ERROR, which the offline queue would retry forever.
   */
  private async classifyResponse(r: Response): Promise<ProviderError> {
    const body = await r.text().catch(() => "");
    return this.classifyBody(r.status, body, r.headers.get("Retry-After"));
  }

  /** Same classification when the caller already consumed the body. */
  private classifyBody(status: number, bodyText: string, retryAfter?: string | null): ProviderError {
    return classifyProviderHttpError({ provider: "Google Drive", status, bodyText, retryAfter });
  }

  private async driveFetch(url: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    // v0.17 D03 — uniform retry envelope; `inspectProviderResponse` decides
    // what the envelope is allowed to see (E8: Drive reports throttling as a
    // 403 with a reason in the body, which the old 429/503-only check missed
    // entirely, so the retry never fired and the rate-limit gate never armed).
    return withRetry(
      { op: "gdrive.driveFetch", maxAttempts: 3, initialDelayMs: 500, signal },
      async (): Promise<Response> => {
        let r: Response;
        try {
          // Download/upload paths may stream multi-MB blobs — give them
          // a wider timeout than metadata requests.
          const isDataPath = /(\/upload\/|alt=media)/.test(url);
          r = await sendWithForcedRefreshOn401({
            init: init ?? {},
            send: (i) =>
              fetchWithTimeout(url, i, {
                channel: "gdrive.fetch",
                timeoutMs: isDataPath ? DEFAULT_DATA_TIMEOUT_MS : DEFAULT_API_TIMEOUT_MS,
                signal,
              }),
            forceRefresh: () => this.forceRefreshAccessToken(),
          });
        } catch (e) {
          throw providerTransportError(e, "Google Drive");
        }
        return inspectProviderResponse(r, "Google Drive");
      },
    );
  }

  /**
   * Find the root folder without creating it (B16).
   *
   * `listFolder` and friends used to go through the creating path, so a plain
   * read — including the connectivity probe, which runs every 30 s — could
   * create `VSCodeSyncFiles/` in a user's Drive. Reads resolve; only writes
   * create.
   */
  private async resolveRootFolderId(token: string): Promise<string | null> {
    const cached = this.folderCache.get(CLOUD_ROOT_DIR);
    if (cached !== undefined) return cached;
    const name = escapeDriveQueryLiteral(CLOUD_ROOT_DIR);
    const q = `name='${name}' and 'root' in parents and mimeType='${MIME_FOLDER}' and trashed=false`;
    const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`;
    const r = await this.driveFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      throw await this.classifyResponse(r);
    }
    const j = (await r.json()) as { files?: DriveFileSummary[] };
    const picked = pickDriveDuplicate(j.files ?? [], CLOUD_ROOT_DIR);
    if (picked?.id !== undefined) {
      this.folderCache.set(CLOUD_ROOT_DIR, picked.id);
      return picked.id;
    }
    return null;
  }

  private async getRootFolderId(token: string): Promise<string> {
    const existing = await this.resolveRootFolderId(token);
    if (existing !== null) return existing;
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
      throw await this.classifyResponse(create);
    }
    const created = (await create.json()) as { id?: string };
    if (!created.id) {
      throw new ProviderError("NETWORK_ERROR", "Google Drive: не удалось создать корневую папку");
    }
    this.folderCache.set(CLOUD_ROOT_DIR, created.id);
    return created.id;
  }

  /**
   * Resolve a file path under VSCodeSyncFiles/ — returns parent folder id, matching item (if any), leaf name.
   */
  /**
   * Read-only leaf lookup: resolves folders without creating any (B16).
   * `null` means "the path does not exist", which every caller already treats
   * as absent.
   */
  private async resolveLeafForRead(
    token: string,
    cloudPath: string,
  ): Promise<{ item: DriveFileSummary | null }> {
    const segments = cloudPath.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== CLOUD_ROOT_DIR) {
      throw new ProviderError("NETWORK_ERROR", `Invalid cloud path: ${cloudPath}`);
    }
    const parentId = await this.resolveFolderPath(
      token,
      segments.slice(0, segments.length - 1).join("/"),
    );
    if (parentId === null) {
      return { item: null };
    }
    const filename = segments[segments.length - 1] ?? "";
    return { item: await this.findChild(token, parentId, filename) };
  }

  /** Folder-path walk that never creates. `null` when a segment is missing. */
  private async resolveFolderPath(token: string, cloudPath: string): Promise<string | null> {
    const trimmed = cloudPath.endsWith("/") ? cloudPath.slice(0, -1) : cloudPath;
    const segments = trimmed.split("/").filter(Boolean);
    if (segments.length < 1 || segments[0] !== CLOUD_ROOT_DIR) {
      throw new ProviderError("NETWORK_ERROR", `Invalid folder path: ${cloudPath}`);
    }
    const cached = this.folderCache.get(trimmed);
    if (cached !== undefined) return cached;
    let parentId = await this.resolveRootFolderId(token);
    if (parentId === null) return null;
    let accum = CLOUD_ROOT_DIR;
    for (let i = 1; i < segments.length; i += 1) {
      const seg = segments[i] ?? "";
      accum = `${accum}/${seg}`;
      const hit = this.folderCache.get(accum);
      if (hit !== undefined) {
        parentId = hit;
        continue;
      }
      const child = await this.findChild(token, parentId, seg);
      if (child?.mimeType !== MIME_FOLDER) {
        return null;
      }
      parentId = child.id;
      this.folderCache.set(accum, parentId);
    }
    return parentId;
  }

  private async ensureFolderPath(token: string, cloudPath: string): Promise<string> {
    const trimmed = cloudPath.endsWith("/") ? cloudPath.slice(0, -1) : cloudPath;
    const segments = trimmed.split("/").filter(Boolean);
    if (segments.length < 1 || segments[0] !== CLOUD_ROOT_DIR) {
      throw new ProviderError("NETWORK_ERROR", `Invalid folder path: ${cloudPath}`);
    }
    const cached = this.folderCache.get(trimmed);
    if (cached !== undefined) return cached;
    let parentId = await this.getRootFolderId(token);
    let accum = CLOUD_ROOT_DIR;
    for (let i = 1; i < segments.length; i += 1) {
      const seg = segments[i] ?? "";
      accum = `${accum}/${seg}`;
      const hit = this.folderCache.get(accum);
      if (hit !== undefined) {
        parentId = hit;
      } else {
        parentId = await this.ensureChildFolder(token, parentId, seg);
        this.folderCache.set(accum, parentId);
      }
    }
    return parentId;
  }

  private async findChild(token: string, parentId: string, name: string): Promise<DriveFileSummary | null> {
    const n = escapeDriveQueryLiteral(name);
    const q = `name='${n}' and '${parentId}' in parents and trashed=false`;
    const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,md5Checksum,modifiedTime)&pageSize=20`;
    const r = await this.driveFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      throw await this.classifyResponse(r);
    }
    const j = (await r.json()) as { files?: DriveFileSummary[] };
    return pickDriveDuplicate(j.files ?? [], name);
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
      throw await this.classifyResponse(r);
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
    // v0.7 — cached folder-path walk so deep paths don't re-resolve every
    // upload.
    let accum = CLOUD_ROOT_DIR;
    for (let i = 1; i < segments.length - 1; i += 1) {
      const seg = segments[i] ?? "";
      accum = `${accum}/${seg}`;
      const hit = this.folderCache.get(accum);
      if (hit !== undefined) {
        parentId = hit;
      } else {
        parentId = await this.ensureChildFolder(token, parentId, seg);
        this.folderCache.set(accum, parentId);
      }
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
      }, options?.signal);
      if (r.status === 412) {
        throw new ProviderError("PRECONDITION_FAILED", "If-Match failed on Google Drive");
      }
      if (!r.ok) {
        throw await this.classifyResponse(r);
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
      // Cast through unknown: our Uint8Array view is fine at runtime; lib.dom
      // declares BodyInit narrower than the current @types/node Buffer.
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit,
    }, options?.signal);
    if (!r.ok) {
      throw await this.classifyResponse(r);
    }
    const etagHdr = normalizeEtag(r.headers.get("etag"));
    const created = (await r.json()) as { md5Checksum?: string; etag?: string };
    return { etag: etagHdr ?? normalizeEtag(created.etag ?? created.md5Checksum ?? null) };
  }

  async downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    const token = await this.accessToken();
    const { item } = await this.resolveLeafForRead(token, cloudPath);
    if (!item?.id || item.mimeType === MIME_FOLDER) {
      throw new ProviderError("NOT_FOUND", cloudPath);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (options?.ifNoneMatch) {
      headers["If-None-Match"] = options.ifNoneMatch;
    }
    const r = await this.driveFetch(`${DRIVE}/files/${item.id}?alt=media`, { headers }, options?.signal);
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
      throw await this.classifyResponse(r);
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
    const { item } = await this.resolveLeafForRead(token, cloudPath);
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
      throw await this.classifyResponse(r);
    }
    const meta = (await r.json()) as DriveFileSummary;
    const etag = normalizeEtag(meta.md5Checksum ?? meta.etag ?? null);
    const sizeNum = meta.size != null ? Number(meta.size) : undefined;
    return {
      cloudPath,
      size: Number.isFinite(sizeNum) ? sizeNum : undefined,
      etag,
      modifiedIso: meta.modifiedTime,
      // Drive's `md5Checksum` is a real content digest (E10). It also happens
      // to be what `etag` falls back to here, but the integrity check must read
      // the field that is defined as a hash, not the one that may be an opaque
      // token on another provider.
      contentDigest:
        typeof meta.md5Checksum === "string" && meta.md5Checksum !== ""
          ? { kind: "md5", value: meta.md5Checksum.toLowerCase() }
          : undefined,
    };
  }

  /** Moves to Drive trash (D11) — `files.delete` destroyed the file outright. */
  async deleteFile(cloudPath: string): Promise<void> {
    const token = await this.accessToken();
    const { item } = await this.resolveLeafForRead(token, cloudPath);
    if (!item?.id) {
      return;
    }
    const r = await this.driveFetch(`${DRIVE}/files/${item.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
    });
    if (r.status === 404) {
      return;
    }
    if (!r.ok) {
      throw await this.classifyResponse(r);
    }
  }

  /** Bypasses the trash — user-invoked purge only (D11). */
  async purgeFilePermanently(cloudPath: string): Promise<void> {
    const token = await this.accessToken();
    const { item } = await this.resolveLeafForRead(token, cloudPath);
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
      throw await this.classifyResponse(r);
    }
  }

  async listFolder(cloudPath: string): Promise<FileMetadata[]> {
    const token = await this.accessToken();
    const folderPath = cloudPath.endsWith("/") ? cloudPath.slice(0, -1) : cloudPath;
    // Listing a folder that does not exist is "empty", not "create it" (B16).
    const folderId = await this.resolveFolderPath(token, folderPath);
    if (folderId === null) {
      return [];
    }
    const prefix = cloudPath.endsWith("/") ? cloudPath : `${cloudPath}/`;
    const out: FileMetadata[] = [];
    // v0.8 F-007 — paginate via Drive `nextPageToken` so workspaces with
    // >1000 children don't silently truncate. Hard cap = 50_000 entries.
    const HARD_CAP = 50_000;
    const q = `'${folderId}' in parents and trashed=false`;
    let nextPageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        fields: "files(id,name,size,md5Checksum,modifiedTime,mimeType),nextPageToken",
        pageSize: "1000",
      });
      if (nextPageToken !== undefined) params.set("pageToken", nextPageToken);
      const url = `${DRIVE}/files?${params.toString()}`;
      const r = await this.driveFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 404) {
        return out;
      }
      if (!r.ok) {
        throw await this.classifyResponse(r);
      }
      const j = (await r.json()) as { files?: DriveFileSummary[]; nextPageToken?: string };
      for (const it of j.files ?? []) {
        const subPath = `${prefix}${it.name}`;
        const etag = normalizeEtag(it.md5Checksum ?? it.etag);
        const sizeNum = it.size != null ? Number(it.size) : undefined;
        out.push({
          cloudPath: subPath,
          size: Number.isFinite(sizeNum) ? sizeNum : undefined,
          etag,
          modifiedIso: it.modifiedTime,
          isFolder: it.mimeType === MIME_FOLDER,
        });
        if (out.length >= HARD_CAP) return out;
      }
      nextPageToken = j.nextPageToken;
    } while (nextPageToken !== undefined && nextPageToken !== "");
    return out;
  }

  async createFolder(cloudPath: string): Promise<void> {
    const token = await this.accessToken();
    await this.ensureFolderPath(token, cloudPath);
  }

  async getWebViewLink(cloudPath: string): Promise<string | null> {
    const token = await this.accessToken();
    const { item } = await this.resolveLeafForRead(token, cloudPath);
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
      throw await this.classifyResponse(r);
    }
    const j = (await r.json()) as { webViewLink?: string };
    return j.webViewLink ?? null;
  }
}
