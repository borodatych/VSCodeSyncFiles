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
import { withRetry } from "../../core/withRetry.js";
import {
  planDropboxUpload,
  type DropboxUploadPlan,
} from "../../core/dropboxUploadSessionPlanner.js";
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
  clearDropboxTokens,
  readDropboxTokens,
  storeDropboxTokens,
  type DropboxTokenBundle,
} from "./dropboxTokens.js";

/**
 * Hard ceiling on `list_folder` pagination. Dropbox returns up to 2000 entries
 * per page by default, so this covers a folder of two million entries — far
 * past anything this extension creates, while still bounding a server that
 * never stops saying `has_more`.
 */
const DROPBOX_LIST_FOLDER_MAX_PAGES = 1000;

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

  /** Owns the SecretStorage key and the per-instance refresh mutex (E4/E14). */
  private readonly tokens: TokenStore<DropboxTokenBundle>;

  constructor(
    private readonly secrets: SecretStore,
    private readonly getDropboxAppKey: () => string,
  ) {
    this.tokens = createTokenStore<DropboxTokenBundle>(secrets, "dropbox");
  }

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

  /** Serialised per provider instance — see E4 note in the Drive provider. */
  private async refreshAccessToken(rt: string): Promise<DropboxTokenBundle> {
    return this.tokens.refreshOnce(() => this.performTokenRefresh(rt));
  }

  private async performTokenRefresh(rt: string): Promise<DropboxTokenBundle> {
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
    return classifyProviderHttpError({ provider: "Dropbox", status, bodyText, retryAfter });
  }

  /**
   * Force a refresh after a 401 — the stored expiry cannot see a grant that the
   * provider revoked server-side.
   */
  private async forceRefreshAccessToken(): Promise<string> {
    const bundle = await readDropboxTokens(this.secrets);
    if (!bundle?.refreshToken) {
      throw new ProviderError("UNAUTHORIZED", "Dropbox: сессия истекла. Выполните повторный вход.");
    }
    const refreshed = await this.refreshAccessToken(bundle.refreshToken);
    return refreshed.accessToken;
  }

  /**
   * Dropbox was the only provider without a retry envelope (E5): a single 500
   * or 429 killed a push outright, while the same blip on OneDrive/Drive was
   * absorbed by three attempts. Users read that as "Dropbox is flaky".
   */
  private async apiFetch(url: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    return withRetry(
      { op: "dropbox.apiFetch", maxAttempts: 3, initialDelayMs: 500, signal },
      async (): Promise<Response> => {
        let r: Response;
        try {
          const isDataPath = /\/files\/(upload|download)/.test(url);
          r = await sendWithForcedRefreshOn401({
            init: init ?? {},
            send: (i) =>
              fetchWithTimeout(url, i, {
                channel: "dropbox.fetch",
                timeoutMs: isDataPath ? DEFAULT_DATA_TIMEOUT_MS : DEFAULT_API_TIMEOUT_MS,
                signal,
              }),
            forceRefresh: () => this.forceRefreshAccessToken(),
          });
        } catch (e) {
          throw providerTransportError(e, "Dropbox");
        }
        return inspectProviderResponse(r, "Dropbox");
      },
    );
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
    throw this.classifyBody(r.status, txt);
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

    // Files over the single-shot limit go through an upload session (E7).
    // `/2/files/upload` refuses ~150 MB+, so without this such a file simply
    // never reached the cloud; `planDropboxUpload` had been written for exactly
    // this and called from nothing but its own test.
    const plan = planDropboxUpload(content.length);
    if (!plan.singleShot) {
      return this.uploadViaSession(dbPath, content, plan, modeArg);
    }

    const token = await this.accessToken();
    const r = await this.apiFetch(`${CONTENT}/2/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(apiArg),
      },
      body: new Uint8Array(content),
    }, options?.signal);

    if (!r.ok) {
      const t = await r.text();
      if (r.status === 409 && options?.ifMatch) {
        throw new ProviderError("PRECONDITION_FAILED", t);
      }
      throw this.classifyBody(r.status, t);
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

  /**
   * `upload_session/{start,append_v2,finish}` for files past the single-shot
   * limit (E7). Chunk boundaries come from the pure planner; this method only
   * performs the calls and keeps the session id.
   */
  private async uploadViaSession(
    dbPath: string,
    content: Buffer,
    plan: DropboxUploadPlan,
    modeArg: unknown,
  ): Promise<UploadResult> {
    const token = await this.accessToken();
    const send = async (
      url: string,
      arg: unknown,
      chunk: Buffer,
    ): Promise<Response> =>
      this.apiFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify(arg),
        },
        body: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) as unknown as BodyInit,
      });

    let sessionId = "";
    for (const c of plan.chunks) {
      const chunk = content.subarray(c.offset, c.offset + c.length);
      if (c.endpoint === "start") {
        const r = await send(`${CONTENT}/2/files/upload_session/start`, { close: false }, chunk);
        if (!r.ok) {
          throw this.classifyBody(r.status, await r.text());
        }
        sessionId = ((await r.json()) as { session_id: string }).session_id;
        continue;
      }
      const cursor = { session_id: sessionId, offset: c.offset };
      if (c.endpoint === "append_v2") {
        const r = await send(
          `${CONTENT}/2/files/upload_session/append_v2`,
          { cursor, close: false },
          chunk,
        );
        if (!r.ok) {
          throw this.classifyBody(r.status, await r.text());
        }
        continue;
      }
      const r = await send(
        `${CONTENT}/2/files/upload_session/finish`,
        {
          cursor,
          commit: { path: dbPath, mode: modeArg, autorename: false, mute: false },
        },
        chunk,
      );
      if (!r.ok) {
        const t = await r.text();
        // Same shape as the single-shot path: a rejected `update` mode is a
        // precondition failure, not a transport problem.
        if (r.status === 409 && typeof modeArg === "object") {
          throw new ProviderError("PRECONDITION_FAILED", t);
        }
        throw this.classifyBody(r.status, t);
      }
      const meta = (await r.json()) as { rev?: string };
      return { etag: normalizeEtag(meta.rev ?? null) };
    }
    throw new Error("dropbox upload session: plan produced no finish chunk");
  }

  async downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    // Dropbox has no conditional download, so `ifNoneMatch` costs one extra
    // `get_metadata` (E13). It is worth it: the alternative is downloading the
    // whole file to discover it is unchanged, and `get_metadata` is orders of
    // magnitude smaller. The extra call shares the retry envelope and the
    // rate-limit gate with everything else, so it cannot silently drive 429s.
    if (options?.ifNoneMatch) {
      const meta = await this.getMetadata(cloudPath);
      if (meta?.etag && meta.etag === options.ifNoneMatch) {
        return { body: Buffer.alloc(0), etag: meta.etag, notModified: true };
      }
    }
    const dbPath = toDropboxPath(cloudPath);
    const apiArg = { path: dbPath };
    const token = await this.accessToken();
    const r = await this.apiFetch(`${CONTENT}/2/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify(apiArg),
      },
    }, options?.signal);
    if (r.status === 409 || r.status === 404) {
      throw new ProviderError("NOT_FOUND", cloudPath);
    }
    if (!r.ok) {
      throw await this.classifyResponse(r);
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
      throw await this.classifyResponse(r);
    }
    const j = (await r.json()) as {
      ".tag"?: string;
      rev?: string;
      size?: number;
      server_modified?: string;
      content_hash?: string;
    };
    return {
      cloudPath,
      size: j[".tag"] === "file" ? j.size : undefined,
      etag: normalizeEtag(j.rev ?? null),
      modifiedIso: j.server_modified,
      // `rev` is a revision token, not a hash (E10) — the real digest is
      // `content_hash`, Dropbox's own block-based scheme.
      contentDigest:
        typeof j.content_hash === "string" && j.content_hash !== ""
          ? { kind: "dropbox-content-hash", value: j.content_hash.toLowerCase() }
          : undefined,
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
      throw this.classifyBody(r.status, txt);
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
    // Ceiling plus a cursor-progress check: `for(;;)` trusted the server to
    // eventually say `has_more: false`. A server that keeps answering
    // `has_more: true` with the same cursor — a bug, a proxy, a truncated
    // response — spun this loop forever, and since the whole call sits on the
    // extension host it reads as a freeze with no error anywhere.
    let pages = 0;
    let previousCursor: string | undefined;
    for (;;) {
      pages += 1;
      if (pages > DROPBOX_LIST_FOLDER_MAX_PAGES) {
        throw new ProviderError(
          "NETWORK_ERROR",
          `Dropbox listFolder: превышен предел в ${String(DROPBOX_LIST_FOLDER_MAX_PAGES)} страниц для ${folderDb}`,
        );
      }
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
        throw await this.classifyResponse(r);
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
      if (page.cursor !== undefined && page.cursor === previousCursor) {
        throw new ProviderError(
          "NETWORK_ERROR",
          `Dropbox listFolder: курсор не продвигается для ${folderDb}`,
        );
      }
      previousCursor = cursor;
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
        isFolder: it[".tag"] === "folder",
      };
    });
  }

  /**
   * Web page of the file in Dropbox (E13). The other three providers had this;
   * only Dropbox left "Open in cloud storage" doing nothing.
   *
   * `create_shared_link_with_settings` returns the existing link when one is
   * already there (409 `shared_link_already_exists`), so calling it twice does
   * not create a second link.
   */
  async getWebViewLink(cloudPath: string): Promise<string | null> {
    const r = await this.rpc("/2/sharing/create_shared_link_with_settings", {
      path: toDropboxPath(cloudPath),
    });
    if (r.ok) {
      const j = (await r.json()) as { url?: string };
      return j.url ?? null;
    }
    if (r.status !== 409) {
      return null;
    }
    // Already shared — ask for the link that exists.
    const existing = await this.rpc("/2/sharing/list_shared_links", {
      path: toDropboxPath(cloudPath),
      direct_only: true,
    });
    if (!existing.ok) {
      return null;
    }
    const j = (await existing.json()) as { links?: { url?: string }[] };
    return j.links?.[0]?.url ?? null;
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
