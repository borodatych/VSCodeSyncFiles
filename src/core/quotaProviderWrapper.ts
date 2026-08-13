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

  // Optional methods must be forwarded, not dropped: a wrapper that silently
  // loses `moveFile` demotes every canonical rename back to a full
  // download+upload, and the caller has no way to notice. Same trap the queue
  // wrapper fell into. `moveFile` and `purgeFilePermanently` are data-plane —
  // they count; `getWebViewLink` builds a URL and does not.
  if (provider.moveFile !== undefined) {
    wrapped.moveFile = (from: string, to: string): Promise<UploadResult> => {
      record();
      return provider.moveFile!(from, to);
    };
  }
  if (provider.purgeFilePermanently !== undefined) {
    wrapped.purgeFilePermanently = (cloudPath: string): Promise<void> => {
      record();
      return provider.purgeFilePermanently!(cloudPath);
    };
  }
  if (provider.getWebViewLink !== undefined) {
    wrapped.getWebViewLink = (cloudPath: string): Promise<string | null> =>
      provider.getWebViewLink!(cloudPath);
  }

  return wrapped;
}
