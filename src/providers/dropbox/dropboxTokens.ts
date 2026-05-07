import type { SecretStore } from "../../core/types.js";

export const DROPBOX_TOKEN_KEY = "vscodesync.dropbox.oauth";

export interface DropboxTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

export async function readDropboxTokens(secrets: SecretStore): Promise<DropboxTokenBundle | null> {
  const raw = await secrets.get(DROPBOX_TOKEN_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DropboxTokenBundle;
  } catch {
    return null;
  }
}

export async function storeDropboxTokens(secrets: SecretStore, bundle: DropboxTokenBundle): Promise<void> {
  await secrets.store(DROPBOX_TOKEN_KEY, JSON.stringify(bundle));
}

export async function clearDropboxTokens(secrets: SecretStore): Promise<void> {
  await secrets.delete(DROPBOX_TOKEN_KEY);
}
