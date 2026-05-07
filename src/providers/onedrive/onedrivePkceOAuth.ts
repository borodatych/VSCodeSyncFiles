/**
 * OneDrive PKCE OAuth 2.0 with loopback redirect (desktop extension).
 * Uses Microsoft identity platform authorization code flow + PKCE (S256).
 * Registered redirect URI must include: http://127.0.0.1:8736/oauth-callback
 */
import type { SecretStore } from "../../core/types.js";
import { storeOneDriveTokens } from "./onedriveProvider.js";
import { runPkceLoopbackOAuth } from "../_shared/pkceLoopbackOAuth.js";

export const ONEDRIVE_PKCE_REDIRECT_PORT = 8736;
export const ONEDRIVE_PKCE_REDIRECT_PATH = "/oauth-callback";
export const ONEDRIVE_PKCE_REDIRECT_URI = `http://127.0.0.1:${String(ONEDRIVE_PKCE_REDIRECT_PORT)}${ONEDRIVE_PKCE_REDIRECT_PATH}`;

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const SCOPE = "Files.ReadWrite offline_access";

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
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: SCOPE,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(`OneDrive PKCE token exchange failed: ${await r.text()}`);
  }
  return (await r.json()) as TokenResponse;
}

/**
 * Authorization code + PKCE (S256) flow for OneDrive.
 * Opens the browser, listens on loopback for the redirect, and stores tokens.
 *
 * @param openAuthUrl - Called with the authorization URL (use vscode.env.openExternal).
 */
export async function runOneDrivePkceOAuth(
  secrets: SecretStore,
  clientId: string,
  openAuthUrl: (url: string) => void,
): Promise<void> {
  await runPkceLoopbackOAuth({
    providerLabel: "OneDrive",
    port: ONEDRIVE_PKCE_REDIRECT_PORT,
    redirectPath: ONEDRIVE_PKCE_REDIRECT_PATH,
    authUrl: AUTH_URL,
    clientId,
    scope: SCOPE,
    extraAuthParams: { prompt: "select_account" },
    openAuthUrl,
    onAuthCode: async (code, verifier, redirectUri) => {
      const tok = await exchangeCode(code, verifier, redirectUri, clientId);
      await storeOneDriveTokens(secrets, {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAtMs: Date.now() + tok.expires_in * 1000,
        clientId,
      });
    },
  });
}
