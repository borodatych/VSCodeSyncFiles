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
import {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_DATA_TIMEOUT_MS,
  fetchWithTimeout,
} from "../_shared/fetchWithTimeout.js";
import {
  clearDropboxTokens,
  readDropboxTokens,
  storeDropboxTokens,
  type DropboxTokenBundle,
} from "./dropboxTokens.js";

const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";

function normalizeEtag(h: string | null | undefined): string | undefined {
  if (!h) {
    return undefined;
  }
  return h.replace(/^"+|"+$/g, "");
}

/** Dropbox paths start with `/`; internal cloud paths match OneDrive-style without leading slash. */
export function toDropboxPath(cloudPath: string): string {
  const s = cloudPath.replace(/^\/+/, "");
  return `/${s}`;
}

interface RpcErr {
  error_summary?: string;
  error?: { ".tag"?: string };
}

export class DropboxProvider implements ICloudProvider {
  readonly type: ProviderType = "dropbox";

  constructor(
    private readonly secrets: SecretStore,
    private readonly getDropboxAppKey: () => string,
  ) {}

  async isAuthenticated(): Promise<boolean> {
    const t = await readDropboxTokens(this.secrets);
    return !!t?.accessToken;
  }

  async authenticate(): Promise<void> {
    await Promise.resolve();
    throw new Error("Use VSCodeSync: Sign in to Dropbox");
  }

  async logout(): Promise<void> {
    await clearDropboxTokens(this.secrets);
  }

  private async refreshAccessToken(rt: string): Promise<DropboxTokenBundle> {
    const key = this.getDropboxAppKey();
    if (!key) {
      throw new ProviderError("UNAUTHORIZED", "Dropbox: задайте vscodesync.dropboxAppKey.");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: key,
    });
    const r = await fetchWithTimeout(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, { channel: "dropbox.fetch", timeoutMs: DEFAULT_API_TIMEOUT_MS });
    if (!r.ok) {
      throw new ProviderError("UNAUTHORIZED", await r.text());
    }
    const j = (await r.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const bundle: DropboxTokenBundle = {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? rt,
      expiresAtMs: Date.now() + (j.expires_in ?? 14400) * 1000,
    };
    await storeDropboxTokens(this.secrets, bundle);
    return bundle;
  }

  private async accessToken(): Promise<string> {
    let bundle = await readDropboxTokens(this.secrets);
    if (!bundle?.accessToken) {
      throw new ProviderError("UNAUTHORIZED", "Dropbox: нет токена. Выполните вход.");
    }
    const skewMs = 5 * 60 * 1000;
    if (bundle.expiresAtMs - Date.now() < skewMs && bundle.refreshToken) {
      bundle = await this.refreshAccessToken(bundle.refreshToken);
    }
    return bundle.accessToken;
  }

  private async apiFetch(url: string, init?: RequestInit): Promise<Response> {
    let r: Response;
    try {
      const isDataPath = /\/files\/(upload|download)/.test(url);
      r = await fetchWithTimeout(url, init ?? {}, {
        channel: "dropbox.fetch",
        timeoutMs: isDataPath ? DEFAULT_DATA_TIMEOUT_MS : DEFAULT_API_TIMEOUT_MS,
      });
    } catch (e) {
      bumpOfflineFlushBackoff();
      noteCloudTransportFailure();
      throw new ProviderError("NETWORK_ERROR", e instanceof Error ? e.message : String(e), { cause: e });
    }
    if (r.status === 429 || r.status === 503) {
      const ra = parseRetryAfterToDelayMs(r.headers.get("Retry-After"));
      noteProviderRateLimited(ra);
      throw new ProviderError("RATE_LIMITED", `Dropbox throttled (${String(r.status)})`, {
        retryAfterMs: ra,
      });
    }
    if (r.ok || r.status === 304) {
      noteProviderRequestSuccess();
      noteCloudTransportSuccess();
    }
    return r;
  }

  private async rpc(path: string, body: object): Promise<Response> {
    const token = await this.accessToken();
    return this.apiFetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private async tryCreateFolder(dropboxFolderPath: string): Promise<void> {
    const r = await this.rpc("/2/files/create_folder_v2", {
      path: dropboxFolderPath,
      autorename: false,
    });
    if (r.ok) {
      return;
    }
    const txt = await r.text();
    let j: RpcErr | undefined;
    try {
      j = JSON.parse(txt) as RpcErr;
    } catch {
      /* ignore */
    }
    const tag = j?.error?.[".tag"];
    if (r.status === 409 && (tag === "path" || txt.includes("conflict"))) {
      return;
    }
    throw new ProviderError("NETWORK_ERROR", txt);
  }

  /** Ensures parent folders exist for a file path (segments except leaf name). */
  private async ensureParentFolders(dropboxFilePath: string): Promise<void> {
    const parts = dropboxFilePath.split("/").filter(Boolean);
    if (parts.length <= 1) {
      return;
    }
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc += `/${parts[i] ?? ""}`;
      await this.tryCreateFolder(acc);
    }
  }

  async uploadFile(cloudPath: string, content: Buffer, options?: UploadOptions): Promise<UploadResult> {
    const dbPath = toDropboxPath(cloudPath);
    await this.ensureParentFolders(dbPath);

    const modeArg: unknown = options?.ifMatch
      ? { ".tag": "update", update: options.ifMatch }
      : "overwrite";

    const apiArg = {
      path: dbPath,
      mode: modeArg,
      autorename: false,
      mute: false,
    };

    const token = await this.accessToken();
    const r = await this.apiFetch(`${CONTENT}/2/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(apiArg),
      },
      body: new Uint8Array(content),
    });

    if (!r.ok) {
      const t = await r.text();
      if (r.status === 409 && options?.ifMatch) {
        throw new ProviderError("PRECONDITION_FAILED", t);
      }
      throw new ProviderError("NETWORK_ERROR", t);
    }
    const metaHdr = r.headers.get("Dropbox-API-Result");
    let rev: string | undefined;
    if (metaHdr) {
      try {
        const meta = JSON.parse(metaHdr) as { rev?: string };
        rev = meta.rev;
      } catch {
        /* ignore */
      }
    }
    return { etag: normalizeEtag(rev ?? null) };
  }

  async downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    void options?.ifNoneMatch;
    const dbPath = toDropboxPath(cloudPath);
    const apiArg = { path: dbPath };
    const token = await this.accessToken();
    const r = await this.apiFetch(`${CONTENT}/2/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify(apiArg),
      },
    });
    if (r.status === 409 || r.status === 404) {
      throw new ProviderError("NOT_FOUND", cloudPath);
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const buf = Buffer.from(await r.arrayBuffer());
    let etag: string | undefined;
    const metaHdr = r.headers.get("Dropbox-API-Result");
    if (metaHdr) {
      try {
        const meta = JSON.parse(metaHdr) as { rev?: string };
        etag = normalizeEtag(meta.rev ?? null);
      } catch {
        /* ignore */
      }
    }
    return { body: buf, etag };
  }

  async getMetadata(cloudPath: string): Promise<FileMetadata | null> {
    const r = await this.rpc("/2/files/get_metadata", {
      path: toDropboxPath(cloudPath),
    });
    if (r.status === 409 || r.status === 404) {
      return null;
    }
    if (!r.ok) {
      throw new ProviderError("NETWORK_ERROR", await r.text());
    }
    const j = (await r.json()) as {
      ".tag"?: string;
      rev?: string;
      size?: number;
      server_modified?: string;
    };
    return {
      cloudPath,
      size: j[".tag"] === "file" ? j.size : undefined,
      etag: normalizeEtag(j.rev ?? null),
      modifiedIso: j.server_modified,
    };
  }

  async deleteFile(cloudPath: string): Promise<void> {
    const r = await this.rpc("/2/files/delete_v2", {
      path: toDropboxPath(cloudPath),
    });
    if (!r.ok && r.status !== 404) {
      const txt = await r.text();
      if (r.status === 409 && txt.includes("not_found")) {
        return;
      }
      throw new ProviderError("NETWORK_ERROR", txt);
    }
  }

  async listFolder(cloudPath: string): Promise<FileMetadata[]> {
    const trimmed = cloudPath.endsWith("/") ? cloudPath.slice(0, -1) : cloudPath;
    const folderDb = toDropboxPath(trimmed);
    const prefix = cloudPath.endsWith("/") ? cloudPath : `${cloudPath}/`;

    const entries: {
      ".tag"?: string;
      name?: string;
      rev?: string;
      size?: number;
      server_modified?: string;
    }[] = [];

    let cursor: string | undefined;
    for (;;) {
      const r = cursor
        ? await this.rpc("/2/files/list_folder/continue", { cursor })
        : await this.rpc("/2/files/list_folder", {
            path: folderDb,
            recursive: false,
            include_deleted: false,
          });
      if (r.status === 409 || r.status === 404) {
        return [];
      }
      if (!r.ok) {
        throw new ProviderError("NETWORK_ERROR", await r.text());
      }
      const page = (await r.json()) as {
        entries?: typeof entries;
        cursor?: string;
        has_more?: boolean;
      };
      entries.push(...(page.entries ?? []));
      if (!page.has_more) {
        break;
      }
      cursor = page.cursor;
      if (!cursor) {
        break;
      }
    }

    return entries.map((it) => {
      const name = it.name ?? "";
      const subPath = `${prefix}${name}`;
      const etag = normalizeEtag(it.rev ?? null);
      return {
        cloudPath: subPath,
        size: it[".tag"] === "file" ? it.size : undefined,
        etag,
        modifiedIso: it.server_modified,
      };
    });
  }

  async createFolder(cloudPath: string): Promise<void> {
    const normalized = cloudPath.endsWith("/") ? cloudPath.slice(0, -1) : cloudPath;
    const db = toDropboxPath(normalized);
    const parts = db.split("/").filter(Boolean);
    if (parts.length > 0) {
      let acc = "";
      for (const part of parts) {
        acc += `/${part}`;
        await this.tryCreateFolder(acc);
      }
    }
  }
}
