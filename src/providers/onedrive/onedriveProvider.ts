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
  // The drive root has no path segment: `root:/:/children` is not a valid
  // Graph URL, `root/children` is.
  const encoded = encodeGraphPath(cloudPath);
  return encoded === ""
    ? `${GRAPH}/me/drive/root/children`
    : `${GRAPH}/me/drive/root:/${encoded}:/children`;
}

/** Graph `file.hashes` → the strongest digest we can verify locally (E10). */
function digestFromGraphHashes(
  hashes: { sha256Hash?: string; sha1Hash?: string } | undefined,
): FileMetadata["contentDigest"] {
  if (hashes?.sha256Hash) {
    return { kind: "sha256", value: hashes.sha256Hash.toLowerCase() };
  }
  if (hashes?.sha1Hash) {
    return { kind: "sha1", value: hashes.sha1Hash.toLowerCase() };
  }
  return undefined;
}

/**
 * First byte OneDrive still expects, from a session's `nextExpectedRanges`
 * (E6). Graph answers with entries like `"12345-"` or `"12345-67890"`; an
 * empty list means the session accepted everything, so there is nothing left
 * to send and the caller's loop ends immediately.
 *
 * Anything unparsable answers 0: re-uploading is always safe, resuming from a
 * guess is not.
 */
export function parseNextExpectedOffset(ranges: readonly string[] | undefined): number {
  if (!ranges || ranges.length === 0) {
    return 0;
  }
  let lowest = Number.POSITIVE_INFINITY;
  for (const r of ranges) {
    const start = Number.parseInt(r.split("-")[0] ?? "", 10);
    if (Number.isFinite(start) && start >= 0 && start < lowest) {
      lowest = start;
    }
  }
  return Number.isFinite(lowest) ? lowest : 0;
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
    let etag: string | undefined;

    try {
      // Resume support (E6). A session that was interrupted still holds the
      // bytes it already accepted; asking it where it stands turns a retry into
      // "continue" instead of "upload the whole file again". A brand-new
      // session answers with an empty range list, which starts us at 0.
      let offset = await this.resumeOffsetForSession(uploadUrl);
      while (offset < total) {
        const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total);
        const chunk = content.subarray(offset, end);
        const chunkRes = await this.putUploadChunk(uploadUrl, chunk, offset, end, total);
        if (chunkRes.status === 200 || chunkRes.status === 201) {
          const j = (await chunkRes.json()) as { eTag?: string };
          etag = normalizeEtag(j.eTag ?? null);
        }
        offset = end;
      }
    } catch (e) {
      // An abandoned session keeps the partial upload alive on the service for
      // days and blocks the next attempt with a conflicting range. Closing it
      // is best-effort: the original failure is what the caller must see.
      await this.cancelUploadSession(uploadUrl);
      throw e;
    }
    return { etag };
  }

  /**
   * Single chunk of an upload session, with the same retry envelope and status
   * classification as every other request (E6).
   *
   * It used to go straight through `fetchWithTimeout`: a 429 or 503 on one
   * chunk surfaced as NETWORK_ERROR with no `Retry-After`, a 5xx was not
   * classified at all, and the whole multi-megabyte upload restarted from zero.
   */
  private async putUploadChunk(
    uploadUrl: string,
    chunk: Buffer,
    offset: number,
    end: number,
    total: number,
  ): Promise<Response> {
    return withRetry(
      { op: "onedrive.uploadChunk", maxAttempts: 3, initialDelayMs: 500 },
      async (): Promise<Response> => {
        let r: Response;
        try {
          r = await fetchWithTimeout(
            uploadUrl,
            {
              method: "PUT",
              headers: {
                "Content-Range": `bytes ${String(offset)}-${String(end - 1)}/${String(total)}`,
                "Content-Length": String(chunk.length),
              },
              // Cast through unknown: lib.dom BodyInit is stricter than the
              // runtime accepts. A bare Uint8Array view ships fine over fetch.
              body: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) as unknown as BodyInit,
            },
            { channel: "onedrive.fetch", timeoutMs: DEFAULT_DATA_TIMEOUT_MS },
          );
        } catch (e) {
          throw providerTransportError(e, "OneDrive");
        }
        // 202 means "chunk accepted, more expected" — a success the shared
        // inspector would not recognise.
        if (r.status === 202) {
          return r;
        }
        return inspectProviderResponse(r, "OneDrive");
      },
    );
  }

  /**
   * Where an upload session stands, from `nextExpectedRanges` (E6).
   * Falls back to 0 whenever the answer is missing or unparsable — restarting
   * is always safe, continuing from a guess is not.
   */
  private async resumeOffsetForSession(uploadUrl: string): Promise<number> {
    try {
      const r = await fetchWithTimeout(uploadUrl, { method: "GET" }, {
        channel: "onedrive.fetch",
        timeoutMs: DEFAULT_API_TIMEOUT_MS,
      });
      if (!r.ok) {
        return 0;
      }
      const j = (await r.json()) as { nextExpectedRanges?: string[] };
      return parseNextExpectedOffset(j.nextExpectedRanges);
    } catch {
      return 0;
    }
  }

  /** `DELETE` the session so a failed upload does not linger server-side. */
  private async cancelUploadSession(uploadUrl: string): Promise<void> {
    try {
      await fetchWithTimeout(uploadUrl, { method: "DELETE" }, {
        channel: "onedrive.fetch",
        timeoutMs: DEFAULT_API_TIMEOUT_MS,
      });
    } catch {
      /* best-effort: the caller is already throwing the real error */
    }
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
    const j = (await r.json()) as {
      size?: number;
      eTag?: string;
      lastModifiedDateTime?: string;
      file?: { hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string } };
    };
    return {
      cloudPath,
      size: j.size,
      etag: normalizeEtag(j.eTag ?? null),
      modifiedIso: j.lastModifiedDateTime,
      // Graph exposes real content hashes under `file.hashes` (E10). `eTag`
      // is `{GUID},N` and hashes nothing — comparing it to a digest is what
      // made every push fail with `providerHashVerify` on. quickXorHash is a
      // OneDrive-specific algorithm we do not implement, so it is ignored.
      contentDigest: digestFromGraphHashes(j.file?.hashes),
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

  /**
   * Create the folder, and its parents, if they are missing (E13).
   *
   * This was an empty no-op while the other three providers created folders —
   * OneDrive got away with it because `PUT .../content` creates the path
   * implicitly, but anything that only needs the folder (an empty workspace, a
   * `.history/` prefix) silently did nothing.
   */
  async createFolder(cloudPath: string): Promise<void> {
    const token = await this.accessToken();
    const segments = cloudPath.split("/").filter(Boolean);
    let parent = "";
    for (const seg of segments) {
      const r = await this.graphFetch(childrenUrl(parent), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: seg,
          folder: {},
          // Graph answers 409 for an existing folder unless told otherwise;
          // "fail" plus the 409 branch below keeps this idempotent without
          // renaming anything.
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      });
      if (!r.ok && r.status !== 409) {
        throw await this.classifyResponse(r);
      }
      parent = parent === "" ? seg : `${parent}/${seg}`;
    }
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
