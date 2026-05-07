/**
 * Shared PKCE loopback OAuth flow used by all desktop providers.
 *
 * Each provider supplies the auth/token endpoints, scope, and a token-exchange
 * function that accepts the auth code + PKCE verifier and returns provider-
 * specific tokens. This module owns the loopback HTTP server, state validation,
 * timeouts, and EADDRINUSE handling.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";

export interface PkceFlowParams {
  /** Provider name for error messages and the success page (e.g. "OneDrive"). */
  providerLabel: string;
  /** TCP port to bind on 127.0.0.1 — must match the provider's registered redirect URI. */
  port: number;
  /** Path component of the redirect URI (defaults to `/oauth-callback`). */
  redirectPath?: string;
  /** Authorization endpoint URL (e.g. `https://login.microsoftonline.com/.../authorize`). */
  authUrl: string;
  /** OAuth `client_id`. */
  clientId: string;
  /** OAuth `scope` (provider-specific). */
  scope?: string;
  /**
   * Extra query params to append to the authorization URL (e.g. `prompt=select_account`,
   * `token_access_type=offline`).
   */
  extraAuthParams?: Record<string, string>;
  /** Called with the authorization URL once the loopback is listening. */
  openAuthUrl: (url: string) => void;
  /** Exchange auth code + verifier for tokens and persist them. */
  onAuthCode: (code: string, verifier: string, redirectUri: string) => Promise<void>;
  /** Overall flow timeout in ms. Default 5 min. */
  timeoutMs?: number;
}

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run a PKCE authorization-code flow with a loopback redirect.
 * Resolves when the provider redirects back with a code and `onAuthCode`
 * resolves; rejects on timeout, EADDRINUSE, state mismatch, or any error
 * thrown by `onAuthCode`.
 */
export async function runPkceLoopbackOAuth(params: PkceFlowParams): Promise<void> {
  const redirectPath = params.redirectPath ?? "/oauth-callback";
  const redirectUri = `http://127.0.0.1:${String(params.port)}${redirectPath}`;
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
  const state = base64UrlEncode(crypto.randomBytes(16));
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const authUrl = new URL(params.authUrl);
  authUrl.searchParams.set("client_id", params.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  if (params.scope !== undefined && params.scope.length > 0) {
    authUrl.searchParams.set("scope", params.scope);
  }
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  for (const [k, v] of Object.entries(params.extraAuthParams ?? {})) {
    authUrl.searchParams.set(k, v);
  }

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          if (!req.url?.startsWith(redirectPath)) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          const u = new URL(req.url, `http://127.0.0.1:${String(params.port)}`);
          const err = u.searchParams.get("error_description") ?? u.searchParams.get("error");
          if (err !== null) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(err);
            server.close();
            reject(new Error(err));
            return;
          }
          const code = u.searchParams.get("code");
          const retState = u.searchParams.get("state");
          if (code === null || retState !== state) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Invalid OAuth response");
            server.close();
            reject(new Error(`Invalid OAuth response from ${params.providerLabel}`));
            return;
          }
          await params.onAuthCode(code, verifier, redirectUri);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<html><body><h2>VSCodeSync: ${params.providerLabel} подключён.</h2><p>Можно закрыть эту вкладку.</p></body></html>`,
          );
          server.close();
          resolve();
        } catch (e: unknown) {
          try {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OAuth failed");
          } catch {
            /* ignore — response may already be flushed */
          }
          server.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });

    const to = setTimeout(() => {
      server.close();
      reject(new Error(`${params.providerLabel} PKCE OAuth timeout (${String(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    server.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(to);
      if (e.code === "EADDRINUSE") {
        reject(
          new Error(
            `Порт ${String(params.port)} занят. Перезагрузи окно VS Code (Ctrl+Shift+P → Reload Window) и попробуй снова.`,
          ),
        );
      } else {
        reject(e);
      }
    });

    server.on("close", () => {
      clearTimeout(to);
    });

    server.listen(params.port, "127.0.0.1", () => {
      params.openAuthUrl(authUrl.toString());
    });
  });
}
