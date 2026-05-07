import type { SecretStore } from "../../core/types.js";
import type { ProviderType } from "../../core/types.js";
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

const TOKEN_KEY = "vscodesync.onedrive.oauth";
const GRAPH = "https://graph.microsoft.com/v1.0";

/** Files larger than this use the Upload Session API (Graph limit for simple PUT is 4 MB). */
const UPLOAD_SESSION_THRESHOLD_BYTES = 4 * 1024 * 1024;
/** Chunk size for Upload Session uploads (recommended: multiples of 320 KiB per Graph docs). */
const UPLOAD_CHUNK_BYTES = 5 * 320 * 1024; // 1.6 MB

export interface OneDriveTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  /** Stored during device code login; used for token refresh. */
  clientId?: string;
}

function encodeGraphPath(cloudPath: string): string {
  return cloudPath
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function contentUrl(cloudPath: string): string {
  return `${GRAPH}/me/drive/root:/${encodeGraphPath(cloudPath)}:/content`;
}

function itemUrl(cloudPath: string): string {
  return `${GRAPH}/me/drive/root:/${encodeGraphPath(cloudPath)}:`;
}

function childrenUrl(cloudPath: string): string {
  return `${GRAPH}/me/drive/root:/${encodeGraphPath(cloudPath)}:/children`;
}

function normalizeEtag(h: string | null): string | undefined {
  if (!h) {
    return undefined;
  }
  return h.replace(/^"+|"+$/g, "");
}

export async function readOneDriveTokenBundle(secrets: SecretStore): Promise<OneDriveTokenBundle | null> {
  const raw = await secrets.get(TOKEN_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as OneDriveTokenBundle;
  } catch {
    return null;
  }
}

async function storeOneDriveTokenBundle(secrets: SecretStore, bundle: OneDriveTokenBundle): Promise<void> {
  await secrets.store(TOKEN_KEY, JSON.stringify(bundle));
}

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export async function maybeRefreshToken(secrets: SecretStore, bundle: OneDriveTokenBundle): Promise<OneDriveTokenBundle> {
  if (!bundle.refreshToken || !bundle.clientId) {
    return bundle;
  }
  if (bundle.expiresAtMs > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return bundle;
  }
  // Access token is expiring soon — refresh it
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: bundle.clientId,
    refresh_token: bundle.refreshToken,
    scope: "Files.ReadWrite offline_access",
  });
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return bundle; // Network error — use existing token
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    if (err.error === "invalid_grant" || err.error === "interaction_required") {
      throw new ProviderError("UNAUTHORIZED", "OneDrive: сессия истекла. Выполните повторный вход.");
    }
    return bundle; // Non-fatal refresh failure — use existing token
  }
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const refreshed: OneDriveTokenBundle = {
    ...bundle,
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? bundle.refreshToken,
    expiresAtMs: Date.now() + j.expires_in * 1000,
  };
  await storeOneDriveTokenBundle(secrets, refreshed);
  return refreshed;
}

async function readTokens(secrets: SecretStore): Promise<OneDriveTokenBundle | null> {
  return readOneDriveTokenBundle(secrets);
}

export class OneDriveProvider implements ICloudProvider {
  readonly type: ProviderType = "onedrive";

  constructor(private readonly secrets: SecretStore) {}

  async isAuthenticated(): Promise<boolean> {
    const t = await readTokens(this.secrets);
    return !!t?.accessToken;
  }

  async authenticate(): Promise<void> {
    await Promise.resolve();
    throw new Error("Используйте команду VSCodeSync: Sign in to OneDrive");
  }

  async logout(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
  }

  private async accessToken(): Promise<string> {
    const bundle = await readTokens(this.secrets);
    if (!bundle?.accessToken) {
      throw new ProviderError("UNAUTHORIZED", "OneDrive: нет токена. Выполните вход.");
    }
    const fresh = await maybeRefreshToken(this.secrets, bundle);
    return fresh.accessToken;
  }

  private async graphFetch(url: string, init?: RequestInit): Promise<Response> {
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
      throw new ProviderError("RATE_LIMITED", `OneDrive throttled (${String(r.status)})`, {
        retryAfterMs: ra,
      });
    }
    if (r.status === 304) {
      noteProviderRequestSuccess();
      noteCloudTransportSuccess();
      return r;
    }
    if (r.ok) {
      noteProviderRequestSuccess();
      noteCloudTransportSuccess();
    }
    return r;
  }

  async uploadFile(cloudPath: string, content: Buffer, options?: UploadOptions): Promise<UploadResult> {
    // Use Upload Session for files larger than 4 MB (Graph API limit for simple PUT)
    if (content.length > UPLOAD_SESSION_THRESHOLD_BYTES) {
      return this.uploadLargeFile(cloudPath, content, options);
    }
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (options?.ifMatch) {
      headers["If-Match"] = options.ifMatch;
    }
    const r = await this.graphFetch(contentUrl(cloudPath), {
      method: "PUT",
      headers,
      body: new Uint8Array(content),
    });
    if (r.status === 412) {
      throw new ProviderError("PRECONDITION_FAILED", "If-Match failed on OneDrive");
    }
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 401) {
        throw new ProviderError("UNAUTHORIZED", t);
      }
      throw new ProviderError("NETWORK_ERROR", `${String(r.status)} ${t}`);
    }
    return { etag: normalizeEtag(r.headers.get("etag")) };
  }

  /**
   * Upload a large file (>4 MB) using the OneDrive Upload Session API.
   * Creates a session URL, then sends data in UPLOAD_CHUNK_BYTES chunks.
   * If-Match is honoured on the createUploadSession call.
   */
  private async uploadLargeFile(
    cloudPath: string,
    content: Buffer,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    const token = await this.accessToken();
    const sessionHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (options?.ifMatch) {
      sessionHeaders["If-Match"] = options.ifMatch;
    }
    const sessionUrl = `${GRAPH}/me/drive/root:/${encodeGraphPath(cloudPath)}:/createUploadSession`;
    const sessionRes = await this.graphFetch(sessionUrl, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "replace",
        },
      }),
    });
    if (sessionRes.status === 412) {
      throw new ProviderError("PRECONDITION_FAILED", "If-Match failed on OneDrive upload session");
    }
    if (!sessionRes.ok) {
      const t = await sessionRes.text();
      if (sessionRes.status === 401) throw new ProviderError("UNAUTHORIZED", t);
      throw new ProviderError("NETWORK_ERROR", `createUploadSession ${String(sessionRes.status)} ${t}`);
    }
    const session = (await sessionRes.json()) as { uploadUrl: string };
    const uploadUrl = session.uploadUrl;
    const total = content.length;
    let offset = 0;
    let etag: string | undefined;

    while (offset < total) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total);
      const chunk = content.subarray(offset, end);
      const chunkRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Range": `bytes ${String(offset)}-${String(end - 1)}/${String(total)}`,
          "Content-Length": String(chunk.length),
        },
        body: chunk,
      });
      if (!chunkRes.ok && chunkRes.status !== 202) {
        throw new ProviderError(
          "NETWORK_ERROR",
          `Upload session chunk failed: ${String(chunkRes.status)} ${await chunkRes.text()}`,
        );
      }
      if (chunkRes.status === 200 || chunkRes.status === 201) {
        const j = (await chunkRes.json()) as { eTag?: string };
        etag = normalizeEtag(j.eTag ?? null);
      }
      offset = end;
    }
    return { etag };
  }

  async downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (options?.ifNoneMatch) {
      headers["If-None-Match"] = options.ifNoneMatch;
    }
    const r = await this.graphFetch(contentUrl(cloudPath), { headers });
    if (r.status === 304) {
      return {
        body: Buffer.alloc(0),
        etag: normalizeEtag(r.headers.get("etag")) ?? options?.ifNoneMatch,
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
    return { body: buf, etag: normalizeEtag(r.headers.get("etag")) };
  }

  async getMetadata(cloudPath: string): Promise<FileMetadata | null> {
    const token = await this.accessToken();
    const r = await this.graphFetch(itemUrl(cloudPath), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404) {
      return null;
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const j = (await r.json()) as { size?: number; eTag?: string; lastModifiedDateTime?: string };
    return {
      cloudPath,
      size: j.size,
      etag: normalizeEtag(j.eTag ?? null),
      modifiedIso: j.lastModifiedDateTime,
    };
  }

  async deleteFile(cloudPath: string): Promise<void> {
    const token = await this.accessToken();
    const r = await this.graphFetch(itemUrl(cloudPath), {
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
    const r = await this.graphFetch(childrenUrl(cloudPath), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404) {
      return [];
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const j = (await r.json()) as {
      value?: { name?: string; size?: number; eTag?: string; lastModifiedDateTime?: string }[];
    };
    const prefix = cloudPath.endsWith("/") ? cloudPath : `${cloudPath}/`;
    return (
      j.value?.map((it) => ({
        cloudPath: `${prefix}${it.name ?? ""}`,
        size: it.size,
        etag: normalizeEtag(it.eTag ?? null),
        modifiedIso: it.lastModifiedDateTime,
      })) ?? []
    );
  }

  async createFolder(cloudPath: string): Promise<void> {
    await Promise.resolve();
    void cloudPath;
  }

  /** URL страницы файла в OneDrive (веб-клиент Microsoft). */
  async getWebViewLink(cloudPath: string): Promise<string | null> {
    const token = await this.accessToken();
    const r = await this.graphFetch(itemUrl(cloudPath), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404) {
      return null;
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const j = (await r.json()) as { webUrl?: string };
    return j.webUrl ?? null;
  }
}

export const ONEDRIVE_OAUTH_SECRET_KEY = TOKEN_KEY;

export async function storeOneDriveTokens(secrets: SecretStore, bundle: OneDriveTokenBundle): Promise<void> {
  await secrets.store(TOKEN_KEY, JSON.stringify(bundle));
}
