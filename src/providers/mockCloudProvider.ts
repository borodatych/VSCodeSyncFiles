import type { ProviderType } from "../core/types.js";
import type {
  DownloadOptions,
  DownloadResult,
  FileMetadata,
  ICloudProvider,
  UploadOptions,
  UploadResult,
} from "./cloudProviderTypes.js";
import { ProviderError } from "./cloudProviderTypes.js";

interface StoredFile {
  content: Buffer;
  etag: string;
}

export class MockCloudProvider implements ICloudProvider {
  readonly files = new Map<string, StoredFile>();
  private etagCounter = 1;

  constructor(readonly type: ProviderType = "onedrive") {}

  private nextEtag(): string {
    this.etagCounter += 1;
    return `W/"mock-${String(this.etagCounter)}"`;
  }

  async isAuthenticated(): Promise<boolean> {
    await Promise.resolve();
    return true;
  }

  async authenticate(): Promise<void> {
    await Promise.resolve();
  }

  async logout(): Promise<void> {
    await Promise.resolve();
    this.files.clear();
  }

  async uploadFile(cloudPath: string, content: Buffer, options?: UploadOptions): Promise<UploadResult> {
    await Promise.resolve();
    const prev = this.files.get(cloudPath);
    if (options?.ifMatch !== undefined && prev && prev.etag !== options.ifMatch) {
      throw new ProviderError("PRECONDITION_FAILED", "ETag mismatch (mock 412)");
    }
    const etag = this.nextEtag();
    this.files.set(cloudPath, { content: Buffer.from(content), etag });
    return { etag };
  }

  async downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    await Promise.resolve();
    const rec = this.files.get(cloudPath);
    if (!rec) {
      throw new ProviderError("NOT_FOUND", `missing ${cloudPath}`);
    }
    if (options?.ifNoneMatch !== undefined && options.ifNoneMatch === rec.etag) {
      return { body: Buffer.alloc(0), etag: rec.etag, notModified: true };
    }
    return { body: Buffer.from(rec.content), etag: rec.etag };
  }

  async getMetadata(cloudPath: string): Promise<FileMetadata | null> {
    await Promise.resolve();
    const rec = this.files.get(cloudPath);
    if (!rec) {
      return null;
    }
    return { cloudPath, size: rec.content.length, etag: rec.etag };
  }

  async deleteFile(cloudPath: string): Promise<void> {
    await Promise.resolve();
    this.files.delete(cloudPath);
  }

  async listFolder(cloudPath: string): Promise<FileMetadata[]> {
    await Promise.resolve();
    const prefix = cloudPath.endsWith("/") ? cloudPath : `${cloudPath}/`;
    const out: FileMetadata[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rec = this.files.get(key);
        out.push({ cloudPath: key, size: rec?.content.length, etag: rec?.etag });
      }
    }
    return out;
  }

  async createFolder(cloudPath: string): Promise<void> {
    await Promise.resolve();
    void cloudPath;
  }
}
