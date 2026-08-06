import type { SecretStore } from "../../core/types.js";
import {
  createTokenStore,
  secretKeyForProvider,
  type OAuthTokenBundle,
} from "../_shared/tokenStore.js";

/**
 * Google Drive token storage.
 *
 * The body used to be a byte-identical copy of the other three providers'
 * modules (E14); it now delegates to the shared store, which also owns the
 * refresh mutex. The exported names stay because a dozen call sites use them.
 */
export const GDRIVE_TOKEN_KEY = secretKeyForProvider("gdrive");

export type GdriveTokenBundle = OAuthTokenBundle;

const store = (secrets: SecretStore) => createTokenStore<GdriveTokenBundle>(secrets, "gdrive");

export async function readGdriveTokens(secrets: SecretStore): Promise<GdriveTokenBundle | null> {
  return store(secrets).read();
}

export async function storeGdriveTokens(secrets: SecretStore, bundle: GdriveTokenBundle): Promise<void> {
  await store(secrets).write(bundle);
}

export async function clearGdriveTokens(secrets: SecretStore): Promise<void> {
  await store(secrets).clear();
}
