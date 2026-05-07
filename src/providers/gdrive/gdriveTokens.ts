import type { SecretStore } from "../../core/types.js";

export const GDRIVE_TOKEN_KEY = "vscodesync.gdrive.oauth";

export interface GdriveTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

export async function readGdriveTokens(secrets: SecretStore): Promise<GdriveTokenBundle | null> {
  const raw = await secrets.get(GDRIVE_TOKEN_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as GdriveTokenBundle;
  } catch {
    return null;
  }
}

export async function storeGdriveTokens(secrets: SecretStore, bundle: GdriveTokenBundle): Promise<void> {
  await secrets.store(GDRIVE_TOKEN_KEY, JSON.stringify(bundle));
}

export async function clearGdriveTokens(secrets: SecretStore): Promise<void> {
  await secrets.delete(GDRIVE_TOKEN_KEY);
}
