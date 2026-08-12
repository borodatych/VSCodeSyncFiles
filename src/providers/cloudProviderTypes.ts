import type { ProviderType } from "../core/types.js";

export type ProviderErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "PRECONDITION_FAILED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  /** v0.8 — облако переполнено (HTTP 507 / `storageQuotaExceeded` / `insufficient_space`). */
  | "STORAGE_QUOTA_EXCEEDED"
  /** v0.8 — после upload / download хэш blob'а не совпал с ожиданием. */
  | "INTEGRITY_FAILED"
  /** v0.8 — 5xx ответ от провайдера. Retry-friendly. */
  | "SERVER_ERROR";

export class ProviderError extends Error {
  /** Set for `RATE_LIMITED` when server sent `Retry-After` (milliseconds). */
  readonly retryAfterMs?: number;

  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export interface FileMetadata {
  cloudPath: string;
  size?: number;
  etag?: string;
  modifiedIso?: string;
  /**
   * Whether the entry is a folder, when the provider says so in the listing.
   *
   * All four APIs carry this (`.tag`, `type`, `mimeType`, the Graph `folder`
   * facet), but the field did not exist, so `deleteCloudFolderRecursive` had to
   * probe every single entry with an extra `listFolder` — including plain
   * files, which can never have children. `undefined` means "provider did not
   * say", and callers must fall back to probing.
   */
  isFolder?: boolean;
  /**
   * Digest of the stored bytes as the provider itself computed it (E10).
   *
   * `etag` must not be used for this: on OneDrive it is a Graph token of the
   * form `{GUID},N` and on Dropbox it is `rev` — neither is a hash of anything.
   * The integrity check compared them against a content hash, so with
   * `vscodesync.providerHashVerify` on, every OneDrive push failed with
   * INTEGRITY_FAILED after a *successful* upload.
   *
   * Absent when the provider's metadata carries no digest — the check then
   * skips rather than guessing.
   */
  contentDigest?: {
    kind: "md5" | "sha1" | "sha256" | "dropbox-content-hash";
    /** Lowercase hex. */
    value: string;
  };
}

export interface UploadOptions {
  ifMatch?: string;
  /**
   * Cancellation for this transfer (A5). Data-plane calls are the ones worth
   * interrupting: they carry the bytes and hold the longest timeout.
   */
  signal?: AbortSignal;
}

export interface DownloadOptions {
  ifNoneMatch?: string;
  /** Cancellation for this transfer (A5). */
  signal?: AbortSignal;
}

export interface UploadResult {
  etag?: string;
  version?: string;
}

export interface DownloadResult {
  body: Buffer;
  etag?: string;
  /** Если true, тело может быть пустым (ответ 304). */
  notModified?: boolean;
}

export interface ICloudProvider {
  readonly type: ProviderType;
  isAuthenticated(): Promise<boolean>;
  authenticate(): Promise<void>;
  logout(): Promise<void>;
  uploadFile(cloudPath: string, content: Buffer, options?: UploadOptions): Promise<UploadResult>;
  downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult>;
  getMetadata(cloudPath: string): Promise<FileMetadata | null>;
  /**
   * Move the file to the provider's trash — recoverable by the user (D11).
   *
   * Yandex passed `permanently=true` and Drive used `files.delete`, so half the
   * providers destroyed data that the other half merely trashed, with nothing
   * in this contract saying which you would get. Irreversible removal is
   * `purgeFilePermanently`, and only a direct user command may call it.
   */
  deleteFile(cloudPath: string): Promise<void>;
  /**
   * Irreversible removal. Optional: providers that cannot express it fall back
   * to {@link deleteFile}. Never call from an automatic path.
   */
  purgeFilePermanently?(cloudPath: string): Promise<void>;
  /**
   * Server-side move — metadata-only on every real provider, so a folder
   * rename of N blobs costs N cheap calls instead of N full
   * download+uploads. Optional: canonical renames fall back to
   * transcode-copy+delete when absent, and MUST fall back themselves when the
   * move would change the wire form (hash category or gzip decision flips).
   */
  moveFile?(fromCloudPath: string, toCloudPath: string): Promise<UploadResult>;
  listFolder(cloudPath: string): Promise<FileMetadata[]>;
  createFolder(cloudPath: string): Promise<void>;
  /**
   * Постоянная ссылка на элемент в веб-интерфейсе провайдера (если поддерживается).
   */
  getWebViewLink?(cloudPath: string): Promise<string | null>;
}
