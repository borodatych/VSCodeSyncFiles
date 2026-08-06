/**
 * Yandex Disk sign-in: authorization code + PKCE over the shared loopback flow
 * (E2 + E3).
 *
 * What this replaced, and why both defects were one fix:
 *
 * - **E2:** the flow used `response_type=token` (implicit), so Yandex never
 *   issued a refresh token. The stored bundle had `accessToken` only, which made
 *   the guard `bundle.refreshToken &&` permanently false: `accessToken()` handed out a token it
 *   knew was expired, `refreshAccessToken` was unreachable code, and the user
 *   had no way back other than signing in again — while the failure showed up
 *   as "no network".
 * - **E3:** implicit delivery needs an HTML shim that reads the URL fragment in
 *   the browser and POSTs the token back to the loopback server. That handler
 *   checked nothing — no `state`, no `Origin`, no `Content-Type` — on a fixed
 *   port with a five-minute window, so a cross-origin form POST with
 *   `enctype=text/plain` could plant someone else's token and the user's files
 *   would sync into a stranger's Disk.
 *
 * The authorization-code flow removes the shim entirely: the code arrives as a
 * query parameter on the redirect, `runPkceLoopbackOAuth` validates `state`,
 * and the token exchange happens server-side in the extension host.
 */
import type { SecretStore } from "../../core/types.js";
import { storeYandexTokens } from "./yandexTokens.js";
import { runPkceLoopbackOAuth } from "../_shared/pkceLoopbackOAuth.js";
import { DEFAULT_API_TIMEOUT_MS, fetchWithTimeout } from "../_shared/fetchWithTimeout.js";

/**
 * Must match Redirect URI in Yandex OAuth app (Платформы → Веб-сервисы).
 * Use 127.0.0.1 (not localhost) for consistent behavior on Windows.
 */
export const YANDEX_OAUTH_REDIRECT_PORT = 8735;
export const YANDEX_OAUTH_REDIRECT_PATH = "/oauth-callback";
export const YANDEX_OAUTH_REDIRECT_URI = `http://127.0.0.1:${String(YANDEX_OAUTH_REDIRECT_PORT)}${YANDEX_OAUTH_REDIRECT_PATH}`;

/** Scopes for full-disk read/write under user account (register same in OAuth app). */
export const YANDEX_DISK_SCOPES = "cloud_api:disk.read cloud_api:disk.write";

/** Scope for app-folder only — more restricted, no access to user's other files. */
export const YANDEX_DISK_APP_FOLDER_SCOPE = "cloud_api:disk.app_folder";

const AUTH_URL = "https://oauth.yandex.ru/authorize";
const TOKEN_URL = "https://oauth.yandex.ru/token";

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
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });
  const r = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { channel: "yandex.oauth", timeoutMs: DEFAULT_API_TIMEOUT_MS },
  );
  if (!r.ok) {
    throw new Error(await r.text());
  }
  return (await r.json()) as TokenResponse;
}

/**
 * @param useAppFolder - When true, requests `cloud_api:disk.app_folder` scope.
 */
export async function runYandexOAuthLoopback(
  secrets: SecretStore,
  clientId: string,
  openAuthUrl: (url: string) => void,
  useAppFolder = false,
): Promise<void> {
  await runPkceLoopbackOAuth({
    providerLabel: "Яндекс Диск",
    port: YANDEX_OAUTH_REDIRECT_PORT,
    redirectPath: YANDEX_OAUTH_REDIRECT_PATH,
    authUrl: AUTH_URL,
    clientId,
    scope: useAppFolder ? YANDEX_DISK_APP_FOLDER_SCOPE : YANDEX_DISK_SCOPES,
    openAuthUrl,
    onAuthCode: async (code, verifier, redirectUri) => {
      const tok = await exchangeCode(code, verifier, redirectUri, clientId);
      await storeYandexTokens(secrets, {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        // Yandex issues long-lived access tokens; the default matches the
        // documented year when the response omits `expires_in`.
        expiresAtMs: Date.now() + (tok.expires_in ?? 31_536_000) * 1000,
      });
    },
  });
}
