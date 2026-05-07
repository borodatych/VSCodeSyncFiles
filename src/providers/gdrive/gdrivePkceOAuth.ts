/**
 * Google Drive OAuth 2.0 Authorization Code Flow + PKCE with loopback redirect.
 * For Desktop apps: loopback redirect on 127.0.0.1 (avoids needing a client_secret).
 *
 * Register redirect URI in Google Cloud Console → APIs & Services → Credentials:
 *   http://127.0.0.1:8737/oauth-callback
 *
 * Required scopes: https://www.googleapis.com/auth/drive.file
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { SecretStore } from "../../core/types.js";
import { storeGdriveTokens } from "./gdriveTokens.js";

export const GDRIVE_PKCE_REDIRECT_PORT = 8737;
export const GDRIVE_PKCE_REDIRECT_PATH = "/oauth-callback";
export const GDRIVE_PKCE_REDIRECT_URI = `http://127.0.0.1:${String(GDRIVE_PKCE_REDIRECT_PORT)}${GDRIVE_PKCE_REDIRECT_PATH}`;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
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
    code,
    grant_type: "authorization_code",
    redirect_uri: GDRIVE_PKCE_REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(`Google Drive PKCE token exchange failed: ${await r.text()}`);
  }
  return (await r.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
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
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64Url(crypto.randomBytes(16));

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", GDRIVE_PKCE_REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline"); // request refresh_token
  authUrl.searchParams.set("prompt", "consent"); // force refresh_token on every login

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          if (!req.url?.startsWith(GDRIVE_PKCE_REDIRECT_PATH)) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          const u = new URL(req.url, `http://127.0.0.1:${String(GDRIVE_PKCE_REDIRECT_PORT)}`);
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
            reject(new Error("Invalid OAuth response from Google Drive"));
            return;
          }
          const tok = await exchangeCode(code, verifier, clientId);
          await storeGdriveTokens(secrets, {
            accessToken: tok.access_token,
            refreshToken: tok.refresh_token,
            expiresAtMs: Date.now() + tok.expires_in * 1000,
          });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body><h2>VSCodeSync: Google Drive подключён.</h2><p>Можно закрыть эту вкладку.</p></body></html>",
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
      reject(new Error("Google Drive PKCE OAuth timeout (5 min)"));
    }, TIMEOUT_MS);

    server.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(to);
      if (e.code === "EADDRINUSE") {
        reject(new Error(`Порт ${GDRIVE_PKCE_REDIRECT_PORT} занят. Перезагрузи окно VS Code (Ctrl+Shift+P → Reload Window) и попробуй снова.`));
      } else {
        reject(e);
      }
    });

    server.on("close", () => {
      clearTimeout(to);
    });

    server.listen(GDRIVE_PKCE_REDIRECT_PORT, "127.0.0.1", () => {
      openAuthUrl(authUrl.toString());
    });
  });
}
