import type { SecretStore } from "../../core/types.js";
import { storeDropboxTokens } from "./dropboxTokens.js";
import { runPkceLoopbackOAuth } from "../_shared/pkceLoopbackOAuth.js";

/** Must match redirect URIs registered for the Dropbox app (127.0.0.1 avoids localhost ambiguity on Windows). */
export const DROPBOX_OAUTH_REDIRECT_PORT = 8734;
export const DROPBOX_OAUTH_REDIRECT_PATH = "/oauth-callback";
export const DROPBOX_OAUTH_REDIRECT_URI = `http://127.0.0.1:${String(DROPBOX_OAUTH_REDIRECT_PORT)}${DROPBOX_OAUTH_REDIRECT_PATH}`;

const AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
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
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(await r.text());
  }
  return (await r.json()) as TokenResponse;
}

/**
 * OAuth 2 authorization code + PKCE with loopback redirect (desktop Dropbox app).
 * Register redirect URI exactly: see DROPBOX_OAUTH_REDIRECT_URI.
 */
export async function runDropboxOAuthLoopback(
  secrets: SecretStore,
  clientId: string,
  openAuthUrl: (url: string) => void,
): Promise<void> {
  await runPkceLoopbackOAuth({
    providerLabel: "Dropbox",
    port: DROPBOX_OAUTH_REDIRECT_PORT,
    redirectPath: DROPBOX_OAUTH_REDIRECT_PATH,
    authUrl: AUTH_URL,
    clientId,
    extraAuthParams: { token_access_type: "offline" },
    openAuthUrl,
    onAuthCode: async (code, verifier, redirectUri) => {
      const tok = await exchangeCode(code, verifier, redirectUri, clientId);
      const expiresIn = tok.expires_in ?? 14400;
      await storeDropboxTokens(secrets, {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAtMs: Date.now() + expiresIn * 1000,
      });
    },
  });
}
