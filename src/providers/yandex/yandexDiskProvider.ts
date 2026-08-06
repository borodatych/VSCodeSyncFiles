import { createHash } from "node:crypto";
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
import { withRetry } from "../../core/withRetry.js";
import { createTokenStore, type TokenStore } from "../_shared/tokenStore.js";
import { noteCloudTransportSuccess } from "../../core/syncOfflineHints.js";
import {
  clearYandexTokens,
  readYandexTokens,
  storeYandexTokens,
  type YandexTokenBundle,
} from "./yandexTokens.js";
import { fetchWithTimeout as sharedFetchWithTimeout } from "../_shared/fetchWithTimeout.js";

const API_BASE = "https://cloud-api.yandex.net/v1/disk";

// Yandex Disk returns 423 / DiskResourceLockedError when another operation holds a transient lock.
const LOCKED_RETRY_MAX = 3;
const LOCKED_RETRY_DELAY_MS = 1500;

const API_TIMEOUT_MS = 30_000;   // metadata / auth requests
const DATA_TIMEOUT_MS = 120_000; // upload PUT / download GET

/**
 * Yandex used to carry its own byte-for-byte copy of `fetchWithTimeout`,
 * including the defect where the deadline was disarmed as soon as headers
 * arrived. Delegating to the shared helper means the fix lands here too.
 */
function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return sharedFetchWithTimeout(url, init, { channel: "yandex.fetch", timeoutMs });
}

/** API path in `disk:/relative` or `app:/relative` form (Yandex Disk REST). */
export function toDiskApiPath(cloudPath: string, useAppFolder = false): string {
  const rel = cloudPath.replace(/^\/+/, "");
  return useAppFolder ? `app:/${rel}` : `disk:/${rel}`;
}

export function cloudPathFromDiskApi(pathFromApi: string): string {
  let s = pathFromApi;
  if (s.startsWith("disk:")) {
    s = s.slice("disk:".length);
  } else if (s.startsWith("app:")) {
    s = s.slice("app:".length);
  }
  return s.replace(/^\/+/, "");
}

function etagFromResource(r: { md5?: string; etag?: string }): string | undefined {
  if (r.etag && r.etag.length > 0) {
    return r.etag;
  }
  if (r.md5 && r.md5.length > 0) {
    return r.md5;
  }
  return undefined;
}

export class YandexDiskProvider implements ICloudProvider {
  readonly type: ProviderType = "yandex";

  /** Owns the SecretStorage key and the per-instance refresh mutex (E4/E14). */
  private readonly tokens: TokenStore<YandexTokenBundle>;

  constructor(
    private readonly secrets: SecretStore,
    private readonly getClientId: () => string,
    /** When true, all paths use `app:/` prefix (app-folder scope). Default: false. */
    private readonly useAppFolder = false,
  ) {
    this.tokens = createTokenStore<YandexTokenBundle>(secrets, "yandex");
  }

  async isAuthenticated(): Promise<boolean> {
    const t = await readYandexTokens(this.secrets);
    return !!t?.accessToken;
  }

  async authenticate(): Promise<void> {
    await Promise.resolve();
    throw new Error("Use VSCodeSync: Sign in to Yandex Disk");
  }

  async logout(): Promise<void> {
    await clearYandexTokens(this.secrets);
  }

  /** Serialised per provider instance — see E4 note in the Drive provider. */
  private async refreshAccessToken(rt: string): Promise<YandexTokenBundle> {
    return this.tokens.refreshOnce(() => this.performTokenRefresh(rt));
  }

  private async performTokenRefresh(rt: string): Promise<YandexTokenBundle> {
    const clientId = this.getClientId();
    if (!clientId) {
      throw new ProviderError("UNAUTHORIZED", "Yandex Disk: задайте vscodesync.yandexOAuthClientId.");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: clientId,
    });
    const r = await fetchWithTimeout("https://oauth.yandex.ru/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, API_TIMEOUT_MS);
    if (!r.ok) {
      // A token endpoint answers 400/401 for a dead grant but 5xx when it is
      // merely unwell; calling both UNAUTHORIZED would sign the user out over
      // a blip, so the status decides.
      throw await this.classifyResponse(r);
    }
    const j = (await r.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const bundle: YandexTokenBundle = {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? rt,
      expiresAtMs: Date.now() + (j.expires_in ?? 3600) * 1000,
    };
    await storeYandexTokens(this.secrets, bundle);
    return bundle;
  }

  private async accessToken(): Promise<string> {
    let bundle = await readYandexTokens(this.secrets);
    if (!bundle?.accessToken) {
      throw new ProviderError("UNAUTHORIZED", "Yandex Disk: нет токена. Выполните вход.");
    }
    const skewMs = 5 * 60 * 1000;
    if (bundle.expiresAtMs - Date.now() < skewMs && bundle.refreshToken) {
      bundle = await this.refreshAccessToken(bundle.refreshToken);
    }
    return bundle.accessToken;
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
    return classifyProviderHttpError({ provider: "Yandex Disk", status, bodyText, retryAfter });
  }

  /**
   * Yandex signs requests with `OAuth <token>`, not `Bearer`, so it keeps its
   * own 401 branch instead of the shared `sendWithForcedRefreshOn401`.
   *
   * The retry envelope is safe next to the provider's 423-locked loops (E5):
   * `inspectProviderResponse` never throws on 423, so those loops still see the
   * response and handle the lock themselves.
   */
  private async apiFetch(pathAndQuery: string, init?: RequestInit): Promise<Response> {
    const url = `${API_BASE}/${pathAndQuery.replace(/^\//, "")}`;
    const withAuth = (authTok: string): RequestInit => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `OAuth ${authTok}`);
      return { ...init, headers };
    };
    return withRetry(
      { op: "yandex.apiFetch", maxAttempts: 3, initialDelayMs: 500 },
      async (): Promise<Response> => {
        const token = await this.accessToken();
        let r: Response;
        try {
          r = await fetchWithTimeout(url, withAuth(token), API_TIMEOUT_MS);
        } catch (e) {
          throw providerTransportError(e, "Yandex Disk");
        }
        if (r.status === 401) {
          const bundle = await readYandexTokens(this.secrets);
          if (bundle?.refreshToken) {
            try {
              await this.refreshAccessToken(bundle.refreshToken);
              const token2 = await this.accessToken();
              try {
                r = await fetchWithTimeout(url, withAuth(token2), API_TIMEOUT_MS);
              } catch (e) {
                throw providerTransportError(e, "Yandex Disk");
              }
            } catch (e) {
              // A dead grant must not be swallowed: rethrowing keeps
              // UNAUTHORIZED (and the "sign in again" dialog) instead of
              // letting the original 401 leave as a generic NETWORK_ERROR.
              if (e instanceof ProviderError && e.code === "UNAUTHORIZED") {
                throw e;
              }
              /* transient refresh failure — fall through with the original 401 */
            }
          }
        }
        return inspectProviderResponse(r, "Yandex Disk");
      },
    );
  }

  private async getResourceJson(pathAndQuery: string): Promise<unknown> {
    const r = await this.apiFetch(pathAndQuery);
    if (r.status === 404) {
      return null;
    }
    if (!r.ok) {
      throw await this.classifyResponse(r);
    }
    return r.json();
  }

  async getMetadata(cloudPath: string): Promise<FileMetadata | null> {
    const apiPath = encodeURIComponent(toDiskApiPath(cloudPath, this.useAppFolder));
    const j = (await this.getResourceJson(`resources?path=${apiPath}`)) as {
      type?: string;
      size?: number;
      modified?: string;
      md5?: string;
      etag?: string;
    } | null;
    if (j?.type !== "file") {
      return null;
    }
    return {
      cloudPath,
      size: j.size,
      etag: etagFromResource(j),
      modifiedIso: j.modified,
    };
  }

  async uploadFile(cloudPath: string, content: Buffer, options?: UploadOptions): Promise<UploadResult> {
    if (options?.ifMatch) {
      const cur = await this.getMetadata(cloudPath);
      if (cur?.etag !== options.ifMatch) {
        throw new ProviderError("PRECONDITION_FAILED", "Yandex Disk: ETag mismatch before upload");
      }
    }

    await this.ensureParentFolders(cloudPath);
    const pathEnc = encodeURIComponent(toDiskApiPath(cloudPath, this.useAppFolder));
    let rUp!: Response;
    for (let attempt = 0; attempt <= LOCKED_RETRY_MAX; attempt++) {
      rUp = await this.apiFetch(`resources/upload?path=${pathEnc}&overwrite=true`);
      if (rUp.ok) {
        break;
      }
      const txt = await rUp.text();
      let code = "";
      try {
        code = (JSON.parse(txt) as { error?: string }).error ?? "";
      } catch { /* ignore */ }
      if ((rUp.status === 423 || code === "DiskResourceLockedError") && attempt < LOCKED_RETRY_MAX) {
        await new Promise<void>((resolve) => { setTimeout(resolve, LOCKED_RETRY_DELAY_MS); });
        continue;
      }
      throw this.classifyBody(rUp.status, txt);
    }
    const up = (await rUp.json()) as { href?: string };
    if (!up.href) {
      throw new ProviderError("NETWORK_ERROR", "Yandex Disk: no upload href");
    }
    let put: Response;
    try {
      put = await fetchWithTimeout(up.href, {
        method: "PUT",
        body: new Uint8Array(content),
      }, DATA_TIMEOUT_MS);
    } catch (e) {
      throw providerTransportError(e, "Yandex Disk");
    }
    if (!put.ok) {
      throw await this.classifyResponse(put);
    }
    noteCloudTransportSuccess();

    // md5 integrity check: compare local md5 with the one returned by Yandex Disk metadata
    const after = await this.getMetadata(cloudPath);
    if (after?.etag) {
      const localMd5 = createHash("md5").update(content).digest("hex");
      // Yandex Disk may return md5 as etag (see etagFromResource) — verify if it looks like md5 (32 hex chars)
      if (/^[0-9a-f]{32}$/i.test(after.etag) && after.etag.toLowerCase() !== localMd5) {
        throw new ProviderError(
          "NETWORK_ERROR",
          `Yandex Disk: md5 mismatch after upload (local: ${localMd5}, cloud: ${after.etag}). Upload may be corrupted.`,
        );
      }
    }

    return { etag: after?.etag };
  }

  async downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    let preCheckedEtag: string | undefined;
    if (options?.ifNoneMatch) {
      const meta = await this.getMetadata(cloudPath).catch(() => null);
      if (meta?.etag && meta.etag === options.ifNoneMatch) {
        return { body: Buffer.alloc(0), notModified: true };
      }
      preCheckedEtag = meta?.etag;
    }
    const pathEnc = encodeURIComponent(toDiskApiPath(cloudPath, this.useAppFolder));
    let rDl!: Response;
    for (let attempt = 0; attempt <= LOCKED_RETRY_MAX; attempt++) {
      rDl = await this.apiFetch(`resources/download?path=${pathEnc}`);
      if (rDl.status === 404) {
        throw new ProviderError("NOT_FOUND", cloudPath);
      }
      if (rDl.ok) {
        break;
      }
      const txt = await rDl.text();
      let code = "";
      try {
        code = (JSON.parse(txt) as { error?: string }).error ?? "";
      } catch { /* ignore */ }
      if ((rDl.status === 423 || code === "DiskResourceLockedError") && attempt < LOCKED_RETRY_MAX) {
        await new Promise<void>((resolve) => { setTimeout(resolve, LOCKED_RETRY_DELAY_MS); });
        continue;
      }
      throw this.classifyBody(rDl.status, txt);
    }
    const dl = (await rDl.json()) as { href?: string };
    if (!dl.href) {
      throw new ProviderError("NETWORK_ERROR", "Yandex Disk: no download href");
    }
    let r: Response;
    try {
      r = await fetchWithTimeout(dl.href, {}, DATA_TIMEOUT_MS);
    } catch (e) {
      throw providerTransportError(e, "Yandex Disk");
    }
    if (r.status === 404) {
      throw new ProviderError("NOT_FOUND", cloudPath);
    }
    if (!r.ok) {
      throw await this.classifyResponse(r);
    }
    noteCloudTransportSuccess();
    const buf = Buffer.from(await r.arrayBuffer());
    const etag = preCheckedEtag ?? (await this.getMetadata(cloudPath).catch(() => null))?.etag;
    return { body: buf, etag };
  }

  async deleteFile(cloudPath: string): Promise<void> {
    const pathEnc = encodeURIComponent(toDiskApiPath(cloudPath, this.useAppFolder));
    const r = await this.apiFetch(`resources?path=${pathEnc}&permanently=true`, { method: "DELETE" });
    if (r.ok || r.status === 404) {
      return;
    }
    const txt = await r.text();
    throw this.classifyBody(r.status, txt);
  }

  async listFolder(cloudPath: string): Promise<FileMetadata[]> {
    const trimmed = cloudPath.replace(/\/+$/, "");
    const apiPath = encodeURIComponent(toDiskApiPath(trimmed, this.useAppFolder));
    // v0.8 F-007 — Yandex paginates via `offset`/`limit`. Walk until we've
    // collected everything or hit the hard cap.
    const HARD_CAP = 50_000;
    const PAGE = 1000;
    const out: FileMetadata[] = [];
    let firstHop = true;
    for (let offset = 0; offset < HARD_CAP; offset += PAGE) {
      const r = await this.apiFetch(`resources?path=${apiPath}&limit=${String(PAGE)}&offset=${String(offset)}`);
      if (r.status === 404) {
        return firstHop ? [] : out;
      }
      if (!r.ok) {
        throw await this.classifyResponse(r);
      }
      const j = (await r.json()) as {
        type?: string;
        _embedded?: {
          total?: number;
          items?: {
            name?: string;
            path?: string;
            type?: string;
            size?: number;
            modified?: string;
            md5?: string;
            etag?: string;
          }[];
        };
      };
      const items = j._embedded?.items ?? [];
      for (const it of items) {
        const cp = it.path ? cloudPathFromDiskApi(it.path) : `${trimmed}/${it.name ?? ""}`;
        out.push({
          cloudPath: cp,
          size: it.type === "file" ? it.size : undefined,
          etag: etagFromResource(it),
          modifiedIso: it.modified,
          isFolder: it.type === "dir",
        });
        if (out.length >= HARD_CAP) break;
      }
      firstHop = false;
      const total = j._embedded?.total ?? items.length;
      if (offset + items.length >= total || items.length === 0) break;
    }
    return out;
  }

  private async tryCreateFolderDiskPath(diskPathFull: string): Promise<void> {
    const pathEnc = encodeURIComponent(diskPathFull);

    for (let attempt = 0; attempt <= LOCKED_RETRY_MAX; attempt++) {
      const r = await this.apiFetch(`resources?path=${pathEnc}`, { method: "PUT" });
      if (r.ok) {
        return;
      }
      const txt = await r.text();
      if (r.status === 409 || r.status === 201) {
        return;
      }
      let code = "";
      try {
        const j = JSON.parse(txt) as { error?: string };
        code = j.error ?? "";
      } catch {
        /* ignore */
      }
      if (code === "DiskPathPointsToExistentDirectoryError" || txt.includes("DiskPathPointsToExistentDirectory")) {
        return;
      }
      if ((r.status === 423 || code === "DiskResourceLockedError") && attempt < LOCKED_RETRY_MAX) {
        await new Promise<void>((resolve) => { setTimeout(resolve, LOCKED_RETRY_DELAY_MS); });
        continue;
      }
      throw this.classifyBody(r.status, txt);
    }
  }

  async createFolder(cloudPath: string): Promise<void> {
    const rel = cloudPath.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!rel) {
      return;
    }
    const parts = rel.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      await this.tryCreateFolderDiskPath(toDiskApiPath(acc, this.useAppFolder));
    }
  }

  async getWebViewLink(cloudPath: string): Promise<string | null> {
    if (this.useAppFolder) {
      // Resolve actual disk:/ path via API since app:/ paths use an unknown app-folder name
      const diskPath = toDiskApiPath(cloudPath, true);
      const pathEnc = encodeURIComponent(diskPath);
      const r = await this.apiFetch(`resources?path=${pathEnc}&fields=path`);
      if (!r.ok) {
        return null;
      }
      const j = (await r.json()) as { path?: string };
      const actualPath = j.path; // e.g. "disk:/Приложения/AppName/file.txt"
      if (!actualPath) {
        return null;
      }
      const rel = actualPath.replace(/^disk:\//, "").replace(/^\/+/, "");
      const encoded = rel.split("/").map(encodeURIComponent).join("/");
      return `https://disk.yandex.ru/client/disk/${encoded}`;
    }
    const rel = cloudPath.replace(/^\/+/, "");
    const encoded = rel.split("/").map(encodeURIComponent).join("/");
    return `https://disk.yandex.ru/client/disk/${encoded}`;
  }

  private async ensureParentFolders(cloudPath: string): Promise<void> {
    const rel = cloudPath.replace(/^\/+/, "");
    const parts = rel.split("/").filter(Boolean);
    if (parts.length <= 1) {
      return;
    }
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i] ?? ""}` : (parts[i] ?? "");
      await this.tryCreateFolderDiskPath(toDiskApiPath(acc, this.useAppFolder));
    }
  }
}
