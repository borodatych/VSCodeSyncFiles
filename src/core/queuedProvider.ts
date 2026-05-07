/**
 * Wraps an ICloudProvider so that all mutating/reading API calls are serialized
 * through a per-provider RequestQueue (concurrency = 1).
 *
 * Benefits:
 *  - Prevents concurrent API hammering when Watch Mode and onSave triggers fire together.
 *  - Provides a single choke-point for per-provider request counting (rate-limit telemetry).
 *
 * Auth operations (isAuthenticated, authenticate, logout) bypass the queue intentionally
 * — they are control-plane calls, not data-plane API requests.
 */

import type {
  ICloudProvider,
  DownloadOptions,
  DownloadResult,
  FileMetadata,
  UploadOptions,
  UploadResult,
} from "../providers/cloudProviderTypes.js";
import { getGlobalQueue } from "./requestQueue.js";
import { noteProviderApiRequest } from "./syncRateLimitState.js";

/**
 * Returns a new ICloudProvider proxy that routes uploadFile, downloadFile,
 * getMetadata, deleteFile, listFolder, and createFolder through a
 * per-provider-type RequestQueue (concurrency 1).
 */
export function wrapWithQueue(provider: ICloudProvider): ICloudProvider {
  const q = (): ReturnType<typeof getGlobalQueue> => getGlobalQueue(provider.type);
  const track = (): void => noteProviderApiRequest(provider.type);

  const wrapped: ICloudProvider = {
    get type() {
      return provider.type;
    },

    isAuthenticated(): Promise<boolean> {
      return provider.isAuthenticated();
    },

    authenticate(): Promise<void> {
      return provider.authenticate();
    },

    logout(): Promise<void> {
      return provider.logout();
    },

    uploadFile(cloudPath: string, content: Buffer, options?: UploadOptions): Promise<UploadResult> {
      return q().enqueue(() => {
        track();
        return provider.uploadFile(cloudPath, content, options);
      });
    },

    downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
      return q().enqueue(() => {
        track();
        return provider.downloadFile(cloudPath, options);
      });
    },

    getMetadata(cloudPath: string): Promise<FileMetadata | null> {
      return q().enqueue(() => {
        track();
        return provider.getMetadata(cloudPath);
      });
    },

    deleteFile(cloudPath: string): Promise<void> {
      return q().enqueue(() => {
        track();
        return provider.deleteFile(cloudPath);
      });
    },

    listFolder(cloudPath: string): Promise<FileMetadata[]> {
      return q().enqueue(() => {
        track();
        return provider.listFolder(cloudPath);
      });
    },

    createFolder(cloudPath: string): Promise<void> {
      return q().enqueue(() => {
        track();
        return provider.createFolder(cloudPath);
      });
    },
  };

  if (provider.getWebViewLink !== undefined) {
    wrapped.getWebViewLink = (cloudPath: string): Promise<string | null> =>
      provider.getWebViewLink!(cloudPath);
  }

  return wrapped;
}
