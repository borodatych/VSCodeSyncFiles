/**
 * Google Drive OAuth 2.0 Authorization Code Flow + PKCE with loopback redirect.
 * For Desktop apps: loopback redirect on 127.0.0.1 (avoids needing a client_secret).
 *
 * Register redirect URI in Google Cloud Console → APIs & Services → Credentials:
 *   http://127.0.0.1:8737/oauth-callback
 *
 * Required scopes: https://www.googleapis.com/auth/drive.file
 */
import type { SecretStore } from "../../core/types.js";
import { storeGdriveTokens } from "./gdriveTokens.js";
import { runPkceLoopbackOAuth } from "../_shared/pkceLoopbackOAuth.js";
import {
  DEFAULT_API_TIMEOUT_MS,
  fetchWithTimeout,
} from "../_shared/fetchWithTimeout.js";

export const GDRIVE_PKCE_REDIRECT_PORT = 8737;
export const GDRIVE_PKCE_REDIRECT_PATH = "/oauth-callback";
export const GDRIVE_PKCE_REDIRECT_URI = `http://127.0.0.1:${String(GDRIVE_PKCE_REDIRECT_PORT)}${GDRIVE_PKCE_REDIRECT_PATH}`;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const r = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, { channel: "gdrive.oauth", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  if (!r.ok) {
    throw new Error(`Google Drive PKCE token exchange failed: ${await r.text()}`);
  }
  return (await r.json()) as TokenResponse;
}

/**
 * Authorization code + PKCE (S256) flow for Google Drive.
 * Opens the browser, waits for redirect on loopback, stores tokens.
 *
 * @param openAuthUrl - Called with the authorization URL (use vscode.env.openExternal).
 */
export async function runGdrivePkceOAuth(
  secrets: SecretStore,
  clientId: string,
  openAuthUrl: (url: string) => void,
): Promise<void> {
  await runPkceLoopbackOAuth({
    providerLabel: "Google Drive",
    port: GDRIVE_PKCE_REDIRECT_PORT,
    redirectPath: GDRIVE_PKCE_REDIRECT_PATH,
    authUrl: AUTH_URL,
    clientId,
    scope: SCOPE,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    openAuthUrl,
    onAuthCode: async (code, verifier, redirectUri) => {
      const tok = await exchangeCode(code, verifier, redirectUri, clientId);
      await storeGdriveTokens(secrets, {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAtMs: Date.now() + tok.expires_in * 1000,
      });
    },
  });
}
