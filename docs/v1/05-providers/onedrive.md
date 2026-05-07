# Провайдер: OneDrive

> Microsoft Graph API. Первый реализованный провайдер (фаза 2).

**Часть фазы:** [05-providers](roadmap.md) — реализован в [02-core-sync](../02-core-sync/roadmap.md)

---

## OAuth 2.0

- [x] **Authorization Code Flow** с PKCE — `src/providers/onedrive/onedrivePkceOAuth.ts`: loopback 127.0.0.1:8736, S256 challenge, `runOneDrivePkceOAuth`
- [x] **Device Code Flow**: `POST /devicecode` → polling `POST /token` (для headless/Remote) — `src/providers/onedrive/onedriveDeviceCode.ts`
- [x] Открыть браузер через `vscode.env.openExternal` (`openExternalBrowser`) + headless-вариант без открытия (`vscodesync.onedriveSignInHeadless`)
- [x] Получить токены → сохранить в `vscode.SecretStorage` (`TOKEN_KEY = "vscodesync.onedrive.oauth"`)
## Авто-refresh токена OneDrive

- [x] `maybeRefreshToken(secrets, bundle)` в `onedriveProvider.ts`:
  - Если `expiresAtMs < now + 5мин` AND `refreshToken` AND `clientId` есть → POST `refresh_token` flow
  - При `invalid_grant` / `interaction_required` → `ProviderError("UNAUTHORIZED")` → re-auth dialog
  - При сетевой ошибке → silent fallback на старый токен
- [x] `clientId` сохраняется в bundle при device code login (`onedriveDeviceCode.ts`)
- [x] `accessToken()` вызывает `maybeRefreshToken` перед каждым запросом
- [x] Unit-тест: `tests/unit/onedriveTokenRefresh.test.ts` — 6 сценариев (valid/skips/refresh/UNAUTHORIZED/network error)
- [x] PKCE Authorization Code Flow — `runOneDrivePkceOAuth` в `onedrivePkceOAuth.ts`
- [x] При `UNAUTHORIZED`: `runWithEngine` перехватывает и предлагает «Войти снова» (`setActiveProvider`)

---

## Microsoft Graph API (`src/providers/onedrive/onedriveProvider.ts`)

- [x] Base URL: `https://graph.microsoft.com/v1.0/me/drive/`
- [x] **Upload**: `PUT /root:/{path}:/content` с `If-Match: <etag>` заголовком
- [x] **Download**: `GET /root:/{path}:/content`; `If-None-Match` → 304 (Conditional GET)
- [x] **Metadata**: `GET /root:/{path}:` → поля `eTag`, `size`, `lastModifiedDateTime`
- [x] **Delete**: `DELETE /root:/{path}:`
- [x] **List folder**: `GET /root:/{path}:/children`
- [x] ETag из ответа: поле `eTag` (обрезка кавычек: `"abc"` → `abc` через `normalizeEtag`)
- [x] Large file upload (> 4 MB): Upload Session — `uploadLargeFile` в `onedriveProvider.ts`; порог 4 MB, чанки 5×320 KB

---

## Базовый путь на облаке

- [x] Папка: `VSCodeSyncFiles/` в корне OneDrive (все пути начинаются с `VSCodeSyncFiles/`)
- [x] Создаётся неявно при первом `uploadFile` (OneDrive создаёт промежуточные папки)

---

## Rate Limits

- [x] При 429/503: `Retry-After` заголовок → `syncRateLimitState` + `parseRetryAfterToDelayMs`
- [x] Глобальная очередь запросов — `src/core/requestQueue.ts`: `RequestQueue` + `getGlobalQueue(namespace)`
