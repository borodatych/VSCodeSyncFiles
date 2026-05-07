import type { SecretStore } from "../../core/types.js";
import { storeOneDriveTokens } from "./onedriveProvider.js";

interface DeviceCodeStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  message?: string;
  interval: number;
  expires_in: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function pollUntilReady(
  deviceCode: string,
  clientId: string,
  intervalSec: number,
  expiresInSec: number,
): Promise<TokenResponse> {
  const started = Date.now();
  const tokenUrl = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  for (;;) {
    if (Date.now() - started > expiresInSec * 1000) {
      throw new Error("Device code истёк");
    }
    await new Promise((r) => setTimeout(r, Math.max(1, intervalSec) * 1000));
    const body = formBody({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: deviceCode,
    });
    const tr = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = (await tr.json()) as TokenResponse & { error?: string; error_description?: string };
    if (j.access_token) {
      return j;
    }
    const err = j.error;
    if (err === "authorization_pending") {
      continue;
    }
    if (err === "slow_down") {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    throw new Error(j.error_description ?? err ?? "OAuth error");
  }
}

/**
 * Device Code Flow (Microsoft identity platform).
 * Нужен зарегистрированный Azure AD app (public client) + clientId в настройках.
 */
export async function runOneDriveDeviceCodeLogin(
  secrets: SecretStore,
  clientId: string,
  onUserCode: (verificationUri: string, userCode: string, message: string) => void,
): Promise<void> {
  const dcUrl = "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode";
  const startRes = await fetch(dcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: clientId,
      scope: "Files.ReadWrite offline_access",
    }),
  });
  if (!startRes.ok) {
    throw new Error(await startRes.text());
  }
  const start = (await startRes.json()) as DeviceCodeStart;
  onUserCode(
    start.verification_uri,
    start.user_code,
    start.message ?? `Откройте ${start.verification_uri} и введите код ${start.user_code}`,
  );
  const tok = await pollUntilReady(start.device_code, clientId, start.interval, start.expires_in);
  const expiresAtMs = Date.now() + tok.expires_in * 1000;
  await storeOneDriveTokens(secrets, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAtMs,
    clientId,
  });
}
