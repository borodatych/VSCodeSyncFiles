/**
 * v3.B — pure DI wrapper that injects `QuotaTracker.recordCall(...)` into
 * every data-plane API call on an `ICloudProvider`. Composes cleanly with
 * `wrapWithQueue` from `queuedProvider.ts`:
 *
 *   wrapWithQuotaTracking(wrapWithQueue(rawProvider), tracker)
 *
 * The two wrappers are independent: the queue serialises calls + records
 * rate-limit state, while this wrapper is concerned only with the quota
 * counter that backs the dashboard / auto-pause logic.
 *
 * No `vscode` import. The tracker itself is pure (`quotaTracker.ts`).
 */

import type {
  DownloadOptions,
  DownloadResult,
  FileMetadata,
  ICloudProvider,
  UploadOptions,
  UploadResult,
} from "../providers/cloudProviderTypes.js";
import type { QuotaTracker } from "./quotaTracker.js";

/** Wrap a provider so every data-plane call (uploadFile, downloadFile,
 * getMetadata, deleteFile, listFolder, createFolder) increments the
 * tracker. Auth operations (isAuthenticated, authenticate, logout) are
 * NOT counted — they are control-plane calls, not API quota consumers. */
export function wrapWithQuotaTracking(
  provider: ICloudProvider,
  tracker: QuotaTracker,
): ICloudProvider {
  const record = (): void => { tracker.recordCall(provider.type); };

  return {
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
      record();
      return provider.uploadFile(cloudPath, content, options);
    },
    downloadFile(cloudPath: string, options?: DownloadOptions): Promise<DownloadResult> {
      record();
      return provider.downloadFile(cloudPath, options);
    },
    getMetadata(cloudPath: string): Promise<FileMetadata | null> {
      record();
      return provider.getMetadata(cloudPath);
    },
    deleteFile(cloudPath: string): Promise<void> {
      record();
      return provider.deleteFile(cloudPath);
    },
    listFolder(cloudPath: string): Promise<FileMetadata[]> {
      record();
      return provider.listFolder(cloudPath);
    },
    createFolder(cloudPath: string): Promise<void> {
      record();
      return provider.createFolder(cloudPath);
    },
  };
}
