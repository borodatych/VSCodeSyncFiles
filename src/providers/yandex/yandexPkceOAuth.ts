import * as http from "node:http";
import type { SecretStore } from "../../core/types.js";
import { storeYandexTokens } from "./yandexTokens.js";

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

/**
 * Implicit flow (response_type=token) — works for Yandex "web service" apps that have
 * client_secret and do not support PKCE without it.
 * Token arrives in the URL fragment; a small HTML shim reads it via JS and POSTs to /token-received.
 *
 * @param useAppFolder - When true, requests `cloud_api:disk.app_folder` scope.
 */
export async function runYandexOAuthLoopback(
  secrets: SecretStore,
  clientId: string,
  openAuthUrl: (url: string) => void,
  useAppFolder = false,
): Promise<void> {
  const authUrl = new URL("https://oauth.yandex.ru/authorize");
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", YANDEX_OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("scope", useAppFolder ? YANDEX_DISK_APP_FOLDER_SCOPE : YANDEX_DISK_SCOPES);

  // HTML shim that reads #access_token from fragment and POSTs it to the local server
  const shimHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>VSCodeSync — Яндекс Диск</title></head><body>
<p>Авторизация...</p>
<script>
  const p = new URLSearchParams(window.location.hash.slice(1));
  const t = p.get('access_token');
  const e = p.get('error_description') || p.get('error');
  if (t) {
    fetch('/token-received', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_token:t,expires_in:p.get('expires_in')})})
      .then(()=>{ document.body.innerHTML='<h2>✅ VSCodeSync: Яндекс Диск подключён. Вкладку можно закрыть.</h2>'; })
      .catch(()=>{ document.body.innerHTML='<h2>Ошибка передачи токена. Попробуйте снова.</h2>'; });
  } else if (e) {
    fetch('/token-received',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:e})});
    document.body.innerHTML='<h2>Ошибка: '+e+'</h2>';
  } else {
    document.body.innerHTML='<h2>Токен не получен. Попробуйте снова.</h2>';
  }
</script></body></html>`;

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        // Step 1: Yandex redirects here with #access_token in fragment — serve HTML shim
        if (req.method === "GET" && req.url?.startsWith(YANDEX_OAUTH_REDIRECT_PATH)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(shimHtml);
          return;
        }

        // Step 2: Shim POSTs the extracted token here
        if (req.method === "POST" && req.url === "/token-received") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            void (async () => {
              res.writeHead(200, { "Content-Type": "text/plain" });
              res.end("ok");
              server.close();
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                  access_token?: string;
                  expires_in?: string;
                  error?: string;
                };
                if (body.error !== undefined && body.error.length > 0) {
                  reject(new Error(body.error));
                  return;
                }
                if (body.access_token === undefined || body.access_token.length === 0) {
                  reject(new Error("Токен не получен"));
                  return;
                }
                const expiresIn = Number(body.expires_in ?? 31536000);
                await storeYandexTokens(secrets, {
                  accessToken: body.access_token,
                  expiresAtMs: Date.now() + expiresIn * 1000,
                });
                resolve();
              } catch (e: unknown) {
                reject(e instanceof Error ? e : new Error(String(e)));
              }
            })();
          });
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      } catch (e: unknown) {
        server.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
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
      if (e.code === "EADDRINUSE") {
        reject(new Error(`Порт ${String(YANDEX_OAUTH_REDIRECT_PORT)} занят. Перезагрузи окно VS Code (Ctrl+Shift+P → Reload Window) и попробуй снова.`));
      } else {
        reject(e);
      }
    });

    server.listen(YANDEX_OAUTH_REDIRECT_PORT, "127.0.0.1", () => {
      openAuthUrl(authUrl.toString());
    });

    server.on("close", () => {
      clearTimeout(to);
    });
  });
}
