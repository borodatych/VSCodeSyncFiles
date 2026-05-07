import * as crypto from "node:crypto";
import * as http from "node:http";
import type { SecretStore } from "../../core/types.js";
import { storeDropboxTokens } from "./dropboxTokens.js";

/** Must match redirect URIs registered for the Dropbox app (127.0.0.1 avoids localhost ambiguity on Windows). */
export const DROPBOX_OAUTH_REDIRECT_PORT = 8734;
export const DROPBOX_OAUTH_REDIRECT_PATH = "/oauth-callback";
export const DROPBOX_OAUTH_REDIRECT_URI = `http://127.0.0.1:${String(DROPBOX_OAUTH_REDIRECT_PORT)}${DROPBOX_OAUTH_REDIRECT_PATH}`;

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  clientId: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: DROPBOX_OAUTH_REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(await r.text());
  }
  return (await r.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
}

let _activeServer: http.Server | null = null;

function closeActiveServer(): void {
  if (_activeServer) {
    try { _activeServer.close(); } catch { /* ignore */ }
    _activeServer = null;
  }
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
  closeActiveServer();

  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64Url(crypto.randomBytes(16));

  const authUrl = new URL("https://www.dropbox.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", DROPBOX_OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("token_access_type", "offline");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      _activeServer = server;
      void (async () => {
        try {
          if (!req.url?.startsWith(DROPBOX_OAUTH_REDIRECT_PATH)) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          const u = new URL(req.url, `http://127.0.0.1:${String(DROPBOX_OAUTH_REDIRECT_PORT)}`);
          const code = u.searchParams.get("code");
          const retState = u.searchParams.get("state");
          const err = u.searchParams.get("error_description") ?? u.searchParams.get("error");
          if (err) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(err);
            server.close();
            reject(new Error(err));
            return;
          }
          if (!code || retState !== state) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Invalid OAuth response");
            server.close();
            reject(new Error("Invalid OAuth response"));
            return;
          }
          const tok = await exchangeCode(code, verifier, clientId);
          const expiresIn = tok.expires_in ?? 14400;
          const expiresAtMs = Date.now() + expiresIn * 1000;
          await storeDropboxTokens(secrets, {
            accessToken: tok.access_token,
            refreshToken: tok.refresh_token,
            expiresAtMs,
          });
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("VSCodeSync: Dropbox connected. You can close this tab.");
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

    const to = setTimeout(
      () => {
        server.close();
        reject(new Error("OAuth timeout (5 min)"));
      },
      5 * 60 * 1000,
    );

    server.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(to);
      _activeServer = null;
      if (e.code === "EADDRINUSE") {
        reject(new Error(`Порт ${DROPBOX_OAUTH_REDIRECT_PORT} занят. Перезагрузи окно VS Code (Ctrl+Shift+P → Reload Window) и попробуй снова.`));
      } else {
        reject(e);
      }
    });

    server.listen(DROPBOX_OAUTH_REDIRECT_PORT, "127.0.0.1", () => {
      _activeServer = server;
      openAuthUrl(authUrl.toString());
    });

    server.on("close", () => {
      clearTimeout(to);
      _activeServer = null;
    });
  });
}
