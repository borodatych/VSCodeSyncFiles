/**
 * v0.17 N19 — pure registry for lazy provider loading.
 *
 * Today's ProviderRegistry imports OneDriveProvider / GdriveProvider /
 * YandexDiskProvider / DropboxProvider at activation time, pulling ~150 KB
 * of OAuth + transport code even when the user only signs into one
 * cloud. This helper holds the metadata + a thunk that resolves the
 * real provider class on first use.
 *
 * Pure: no `vscode`, no `node:`. Caller hands in async loader thunks
 * that perform the actual `import()`.
 */

import type { ICloudProvider, ProviderErrorCode } from "../providers/cloudProviderTypes.js";
import type { ProviderType } from "./types.js";

export interface LazyProviderEntry {
  type: ProviderType;
  /** Async loader — typically `() => import("./onedriveProvider.js")`. */
  load: () => Promise<ICloudProvider>;
  /** Memoised resolved instance. */
  cached: ICloudProvider | null;
}

export interface LazyProviderRegistry {
  /** Look up + load on first access. Subsequent calls return memoised. */
  resolve(type: ProviderType): Promise<ICloudProvider>;
  /** Has a provider type been loaded at least once? */
  isLoaded(type: ProviderType): boolean;
  /** Force a reset — useful for sign-out flows that need to drop cached state. */
  reset(type: ProviderType): void;
}

export function createLazyProviderRegistry(
  entries: readonly { type: ProviderType; load: () => Promise<ICloudProvider> }[],
): LazyProviderRegistry {
  const map = new Map<ProviderType, LazyProviderEntry>();
  for (const e of entries) {
    map.set(e.type, { type: e.type, load: e.load, cached: null });
  }
  return {
    async resolve(type: ProviderType): Promise<ICloudProvider> {
      const entry = map.get(type);
      if (!entry) {
        throw new (class extends Error {
          code: ProviderErrorCode = "NOT_FOUND";
        })(`Provider type not registered: ${type}`);
      }
      entry.cached ??= await entry.load();
      return entry.cached;
    },
    isLoaded(type: ProviderType): boolean {
      return map.get(type)?.cached !== null && map.get(type)?.cached !== undefined;
    },
    reset(type: ProviderType): void {
      const entry = map.get(type);
      if (entry) entry.cached = null;
    },
  };
}
