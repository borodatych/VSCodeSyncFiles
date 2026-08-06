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
import { classifyProviderHttpError } from "../_shared/classifyHttpError.js";
import {
  inspectProviderResponse,
  providerTransportError,
} from "../_shared/providerFetchOutcome.js";
import { sendWithForcedRefreshOn401 } from "../_shared/forcedRefreshFetch.js";
import { createTokenStore, secretKeyForProvider, type TokenStore } from "../_shared/tokenStore.js";
import { withRetry } from "../../core/withRetry.js";
import {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_DATA_TIMEOUT_MS,
  fetchWithTimeout,
} from "../_shared/fetchWithTimeout.js";

const TOKEN_KEY = secretKeyForProvider("onedrive");
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

/**
 * Refresh the access token when it is about to expire, or unconditionally when
 * `force` is set — the caller saw a 401, which means the stored expiry lies
 * (the grant was revoked server-side).
 *
 * A failed refresh falls back to the stored token **only while that token is
 * still valid**. Returning a token that has already expired, as this used to do
 * on every network hiccup and on every non-`invalid_grant` error, guarantees a
 * 401 on the next call and hides the real reason.
 */
export async function maybeRefreshToken(
  secrets: SecretStore,
  bundle: OneDriveTokenBundle,
  opts?: { force?: boolean },
): Promise<OneDriveTokenBundle> {
  if (!bundle.refreshToken || !bundle.clientId) {
    if (opts?.force === true) {
      throw new ProviderError("UNAUTHORIZED", "OneDrive: сессия истекла. Выполните повторный вход.");
    }
    return bundle;
  }
  if (opts?.force !== true && bundle.expiresAtMs > Date.now() + TOKEN_REFRESH_SKEW_MS) {
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
    res = await fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, { channel: "onedrive.fetch", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  } catch (e) {
    // Unreachable token endpoint: the old token is still worth trying while it
    // has time left, but pretending an expired one is usable is a lie.
    if (stillUsable(bundle)) {
      return bundle;
    }
    throw new ProviderError(
      "NETWORK_ERROR",
      `OneDrive: не удалось обновить истёкший токен — ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const err = safeJsonError(bodyText);
    if (err === "invalid_grant" || err === "interaction_required") {
      throw new ProviderError("UNAUTHORIZED", "OneDrive: сессия истекла. Выполните повторный вход.");
    }
    const classified = classifyProviderHttpError({
      provider: "OneDrive",
      status: res.status,
      bodyText,
      retryAfter: res.headers.get("Retry-After"),
    });
    if (classified.code === "UNAUTHORIZED" || !stillUsable(bundle)) {
      throw classified;
    }
    return bundle; // Transient refresh failure and the current token still works.
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

/**
 * A refresh is actually due — checked before entering the refresh mutex so a
 * no-op call cannot be joined by a caller that needs a real refresh.
 */
export function needsOneDriveRefresh(bundle: OneDriveTokenBundle): boolean {
  return (
    bundle.refreshToken !== undefined &&
    bundle.clientId !== undefined &&
    bundle.expiresAtMs <= Date.now() + TOKEN_REFRESH_SKEW_MS
  );
}

/** The stored access token has not expired yet, so a failed refresh is survivable. */
function stillUsable(bundle: OneDriveTokenBundle): boolean {
  return bundle.expiresAtMs > Date.now();
}

function safeJsonError(bodyText: string): string | undefined {
  try {
    return (JSON.parse(bodyText) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

export class OneDriveProvider implements ICloudProvider {
  readonly type: ProviderType = "onedrive";

  /** Owns the SecretStorage key and the per-instance refresh mutex (E4/E14). */
  private readonly tokens: TokenStore<OneDriveTokenBundle>;

  constructor(private readonly secrets: SecretStore) {
    this.tokens = createTokenStore<OneDriveTokenBundle>(secrets, "onedrive");
  }

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
    if (!needsOneDriveRefresh(bundle)) {
      return bundle.accessToken;
    }
    const fresh = await this.tokens.refreshOnce(() => maybeRefreshToken(this.secrets, bundle));
    return fresh.accessToken;
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
    return classifyProviderHttpError({ provider: "OneDrive", status, bodyText, retryAfter });
  }

  /**
   * Force a token refresh after a 401 and hand back the fresh access token.
   * Throws UNAUTHORIZED when the grant is gone — nothing left to retry with.
   */
  private async forceRefreshAccessToken(): Promise<string> {
    const bundle = await readTokens(this.secrets);
    if (!bundle?.accessToken) {
      throw new ProviderError("UNAUTHORIZED", "OneDrive: нет токена. Выполните вход.");
    }
    const fresh = await this.tokens.refreshOnce(() =>
      maybeRefreshToken(this.secrets, bundle, { force: true }),
    );
    return fresh.accessToken;
  }

  private async graphFetch(url: string, init?: RequestInit): Promise<Response> {
    // v0.17 D03 — uniform retry envelope.
    return withRetry(
      { op: "onedrive.graphFetch", maxAttempts: 3, initialDelayMs: 500 },
      async (): Promise<Response> => {
        let r: Response;
        try {
          const isDataPath = /\/content(\?|$)|uploadSession/.test(url);
          r = await sendWithForcedRefreshOn401({
            init: init ?? {},
            send: (i) =>
              fetchWithTimeout(url, i, {
                channel: "onedrive.fetch",
                timeoutMs: isDataPath ? DEFAULT_DATA_TIMEOUT_MS : DEFAULT_API_TIMEOUT_MS,
              }),
            forceRefresh: () => this.forceRefreshAccessToken(),
          });
        } catch (e) {
          throw providerTransportError(e, "OneDrive");
        }
        return inspectProviderResponse(r, "OneDrive");
      },
    );
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
      throw this.classifyBody(r.status, t);
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
      throw this.classifyBody(sessionRes.status, `createUploadSession: ${t}`);
    }
    const session = (await sessionRes.json()) as { uploadUrl: string };
    const uploadUrl = session.uploadUrl;
    const total = content.length;
    let offset = 0;
    let etag: string | undefined;

    while (offset < total) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total);
      const chunk = content.subarray(offset, end);
      const chunkRes = await fetchWithTimeout(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Range": `bytes ${String(offset)}-${String(end - 1)}/${String(total)}`,
          "Content-Length": String(chunk.length),
        },
        // Cast through unknown: lib.dom BodyInit is stricter than the runtime
        // accepts. A bare Uint8Array view ships fine over fetch.
        body: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) as unknown as BodyInit,
      }, { channel: "onedrive.fetch", timeoutMs: DEFAULT_DATA_TIMEOUT_MS });
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
      throw await this.classifyResponse(r);
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
      throw await this.classifyResponse(r);
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
      throw await this.classifyResponse(r);
    }
  }

  async listFolder(cloudPath: string): Promise<FileMetadata[]> {
    const token = await this.accessToken();
    const prefix = cloudPath.endsWith("/") ? cloudPath : `${cloudPath}/`;
    // v0.8 F-007 — follow `@odata.nextLink` for Graph pagination (default
    // 200 items/page). Hard cap defends against runaway folders.
    const HARD_CAP = 50_000;
    const out: FileMetadata[] = [];
    let url: string | undefined = childrenUrl(cloudPath);
    let firstHop = true;
    while (url !== undefined && out.length < HARD_CAP) {
      const r = await this.graphFetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 404) {
        return firstHop ? [] : out;
      }
      if (!r.ok) {
        throw await this.classifyResponse(r);
      }
      const j = (await r.json()) as {
        value?: {
          name?: string;
          size?: number;
          eTag?: string;
          lastModifiedDateTime?: string;
          /** Graph marks a folder by carrying this facet at all. */
          folder?: { childCount?: number };
        }[];
        "@odata.nextLink"?: string;
      };
      for (const it of j.value ?? []) {
        out.push({
          cloudPath: `${prefix}${it.name ?? ""}`,
          size: it.size,
          etag: normalizeEtag(it.eTag ?? null),
          modifiedIso: it.lastModifiedDateTime,
          isFolder: it.folder !== undefined,
        });
        if (out.length >= HARD_CAP) break;
      }
      url = j["@odata.nextLink"];
      firstHop = false;
    }
    return out;
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
      throw await this.classifyResponse(r);
    }
    const j = (await r.json()) as { webUrl?: string };
    return j.webUrl ?? null;
  }
}

export const ONEDRIVE_OAUTH_SECRET_KEY = TOKEN_KEY;

export async function storeOneDriveTokens(secrets: SecretStore, bundle: OneDriveTokenBundle): Promise<void> {
  await secrets.store(TOKEN_KEY, JSON.stringify(bundle));
}
