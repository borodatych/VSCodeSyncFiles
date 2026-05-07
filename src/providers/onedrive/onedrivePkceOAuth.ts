/**
 * OneDrive PKCE OAuth 2.0 with loopback redirect (desktop extension).
 * Uses Microsoft identity platform authorization code flow + PKCE (S256).
 * Registered redirect URI must include: http://127.0.0.1:8736/oauth-callback
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { SecretStore } from "../../core/types.js";
import { storeOneDriveTokens } from "./onedriveProvider.js";

export const ONEDRIVE_PKCE_REDIRECT_PORT = 8736;
export const ONEDRIVE_PKCE_REDIRECT_PATH = "/oauth-callback";
export const ONEDRIVE_PKCE_REDIRECT_URI = `http://127.0.0.1:${String(ONEDRIVE_PKCE_REDIRECT_PORT)}${ONEDRIVE_PKCE_REDIRECT_PATH}`;

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const SCOPE = "Files.ReadWrite offline_access";
const TIMEOUT_MS = 5 * 60 * 1000;

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  clientId: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: ONEDRIVE_PKCE_REDIRECT_URI,
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
  return (await r.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
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
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64Url(crypto.randomBytes(16));

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", ONEDRIVE_PKCE_REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          if (!req.url?.startsWith(ONEDRIVE_PKCE_REDIRECT_PATH)) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          const u = new URL(req.url, `http://127.0.0.1:${String(ONEDRIVE_PKCE_REDIRECT_PORT)}`);
          const err =
            u.searchParams.get("error_description") ?? u.searchParams.get("error");
          if (err) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(err);
            server.close();
            reject(new Error(err));
            return;
          }
          const code = u.searchParams.get("code");
          const retState = u.searchParams.get("state");
          if (!code || retState !== state) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Invalid OAuth response");
            server.close();
            reject(new Error("Invalid OAuth response from OneDrive"));
            return;
          }
          const tok = await exchangeCode(code, verifier, clientId);
          await storeOneDriveTokens(secrets, {
            accessToken: tok.access_token,
            refreshToken: tok.refresh_token,
            expiresAtMs: Date.now() + tok.expires_in * 1000,
            clientId,
          });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body><h2>VSCodeSync: OneDrive подключён.</h2><p>Можно закрыть эту вкладку.</p></body></html>",
          );
          server.close();
          resolve();
        } catch (e) {
          try {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OAuth failed");
          } catch {
            /* ignore */
          }
          server.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });

    const to = setTimeout(() => {
      server.close();
      reject(new Error("OneDrive PKCE OAuth timeout (5 min)"));
    }, TIMEOUT_MS);

    server.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(to);
      if (e.code === "EADDRINUSE") {
        reject(new Error(`Порт ${ONEDRIVE_PKCE_REDIRECT_PORT} занят. Перезагрузи окно VS Code (Ctrl+Shift+P → Reload Window) и попробуй снова.`));
      } else {
        reject(e);
      }
    });

    server.on("close", () => {
      clearTimeout(to);
    });

    server.listen(ONEDRIVE_PKCE_REDIRECT_PORT, "127.0.0.1", () => {
      openAuthUrl(authUrl.toString());
    });
  });
}
