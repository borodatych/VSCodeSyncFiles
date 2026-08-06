/**
 * One SecretStorage layout and one refresh mutex for all four providers
 * (E14 + E4).
 *
 * Each provider used to carry a byte-identical 29-line token module, OneDrive
 * had a fourth inline copy, and the settings panel spelled the same four keys
 * out twice more. None of them serialised refreshes: `registry.ts` hands one
 * provider instance to every consumer, 5+ background tasks start within the
 * same second, and the last writer to SecretStorage won — which, with providers
 * that rotate the refresh token, could leave a revoked bundle stored.
 */
import type { ProviderType, SecretStore } from "../../core/types.js";

export interface OAuthTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

/**
 * SecretStorage key holding a provider's token bundle. This is the format the
 * shipped extension actually writes — `core/types.ts` used to export a
 * `secretKeyForProvider` returning `vscodesync.token.<type>`, which nothing
 * read or wrote.
 */
export function secretKeyForProvider(type: ProviderType): string {
  return `vscodesync.${type}.oauth`;
}

/**
 * Key for one account slot of the multi-account design (`multiAccountConfig.ts`,
 * schema written but not wired). Slots hang off the single-account key so both
 * layouts stay legible side by side.
 */
export function secretKeyForAccountSlot(type: ProviderType, slotId: string): string {
  return `${secretKeyForProvider(type)}:${slotId}`;
}

export interface TokenStore<T extends OAuthTokenBundle> {
  read(): Promise<T | null>;
  write(bundle: T): Promise<void>;
  clear(): Promise<void>;
  /**
   * Refresh serialised per store: concurrent callers share the first in-flight
   * refresh instead of each running their own and racing to persist the result.
   * The slot is cleared on both success and failure, so a failed refresh does
   * not poison later attempts.
   */
  refreshOnce(refresh: () => Promise<T>): Promise<T>;
}

export function createTokenStore<T extends OAuthTokenBundle>(
  secrets: SecretStore,
  type: ProviderType,
): TokenStore<T> {
  const key = secretKeyForProvider(type);
  let inFlight: Promise<T> | null = null;
  return {
    async read(): Promise<T | null> {
      const raw = await secrets.get(key);
      if (!raw) {
        return null;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async write(bundle: T): Promise<void> {
      await secrets.store(key, JSON.stringify(bundle));
    },
    async clear(): Promise<void> {
      await secrets.delete(key);
    },
    refreshOnce(refresh: () => Promise<T>): Promise<T> {
      if (inFlight !== null) {
        return inFlight;
      }
      const p = refresh().finally(() => {
        inFlight = null;
      });
      inFlight = p;
      return p;
    },
  };
}
