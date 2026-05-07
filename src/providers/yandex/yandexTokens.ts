import type { SecretStore } from "../../core/types.js";

export const YANDEX_TOKEN_KEY = "vscodesync.yandex.oauth";

export interface YandexTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

export async function readYandexTokens(secrets: SecretStore): Promise<YandexTokenBundle | null> {
  const raw = await secrets.get(YANDEX_TOKEN_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as YandexTokenBundle;
  } catch {
    return null;
  }
}

export async function storeYandexTokens(secrets: SecretStore, bundle: YandexTokenBundle): Promise<void> {
  await secrets.store(YANDEX_TOKEN_KEY, JSON.stringify(bundle));
}

export async function clearYandexTokens(secrets: SecretStore): Promise<void> {
  await secrets.delete(YANDEX_TOKEN_KEY);
}
