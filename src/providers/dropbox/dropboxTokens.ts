import type { SecretStore } from "../../core/types.js";
import {
  createTokenStore,
  secretKeyForProvider,
  type OAuthTokenBundle,
} from "../_shared/tokenStore.js";

/**
 * Dropbox token storage.
 *
 * The body used to be a byte-identical copy of the other three providers'
 * modules (E14); it now delegates to the shared store, which also owns the
 * refresh mutex. The exported names stay because a dozen call sites use them.
 */
export const DROPBOX_TOKEN_KEY = secretKeyForProvider("dropbox");

export type DropboxTokenBundle = OAuthTokenBundle;

const store = (secrets: SecretStore) => createTokenStore<DropboxTokenBundle>(secrets, "dropbox");

export async function readDropboxTokens(secrets: SecretStore): Promise<DropboxTokenBundle | null> {
  return store(secrets).read();
}

export async function storeDropboxTokens(secrets: SecretStore, bundle: DropboxTokenBundle): Promise<void> {
  await store(secrets).write(bundle);
}

export async function clearDropboxTokens(secrets: SecretStore): Promise<void> {
  await store(secrets).clear();
}
