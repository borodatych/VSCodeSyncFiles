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
}

export interface UploadOptions {
  ifMatch?: string;
}

export interface DownloadOptions {
  ifNoneMatch?: string;
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
  deleteFile(cloudPath: string): Promise<void>;
  listFolder(cloudPath: string): Promise<FileMetadata[]>;
  createFolder(cloudPath: string): Promise<void>;
  /**
   * Постоянная ссылка на элемент в веб-интерфейсе провайдера (если поддерживается).
   */
  getWebViewLink?(cloudPath: string): Promise<string | null>;
}
