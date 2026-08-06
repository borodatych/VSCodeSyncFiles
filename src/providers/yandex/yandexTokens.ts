import type { SecretStore } from "../../core/types.js";
import {
  createTokenStore,
  secretKeyForProvider,
  type OAuthTokenBundle,
} from "../_shared/tokenStore.js";

/**
 * Yandex Disk token storage.
 *
 * The body used to be a byte-identical copy of the other three providers'
 * modules (E14); it now delegates to the shared store, which also owns the
 * refresh mutex. The exported names stay because a dozen call sites use them.
 */
export const YANDEX_TOKEN_KEY = secretKeyForProvider("yandex");

export type YandexTokenBundle = OAuthTokenBundle;

const store = (secrets: SecretStore) => createTokenStore<YandexTokenBundle>(secrets, "yandex");

export async function readYandexTokens(secrets: SecretStore): Promise<YandexTokenBundle | null> {
  return store(secrets).read();
}

export async function storeYandexTokens(secrets: SecretStore, bundle: YandexTokenBundle): Promise<void> {
  await store(secrets).write(bundle);
}

export async function clearYandexTokens(secrets: SecretStore): Promise<void> {
  await store(secrets).clear();
}
