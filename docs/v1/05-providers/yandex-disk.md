# Провайдер: Яндекс Диск

> Яндекс Диск REST API (WebDAV + REST).

**Часть фазы:** [05-providers](roadmap.md)

---

## OAuth 2.0

- [x] Authorization Code Flow + PKCE (без `client_secret`); callback `http://127.0.0.1:8735/oauth-callback`
- [x] Token endpoint: `https://oauth.yandex.ru/token`; refresh по `refresh_token`
- [x] Scopes в запросе: `cloud_api:disk.read cloud_api:disk.write` (зарегистрировать в приложении OAuth)
- [x] Токены в `vscode.SecretStorage`
- [x] Access token: `expires_in` + фоновый refresh при истечении

---

## Яндекс Диск REST API

- [x] Base URL: `https://cloud-api.yandex.net/v1/disk/`
- [x] **Upload**: двухшаговый (`resources/upload` → PUT по `href`)
- [x] **Download**: `resources/download` → GET по `href`
- [x] **Metadata**: `GET /resources?path=...` (etag / md5)
- [x] **Delete**: `DELETE /resources?path=...&permanently=true`
- [x] **List folder**: `_embedded.items`
- [x] **Create folder**: `PUT /resources?path=...` (цепочка родителей)
- [x] ETag: `etag` или fallback `md5`; перед upload при `ifMatch` — сверка метаданных

---

## Особенности

- [x] Папка приложения (`app:/…`): настройка `vscodesync.yandexUseAppFolder: false` (умолч.) — при `true` OAuth запрашивает `cloud_api:disk.app_folder`, пути используют `app:/` вместо `disk:/`; `toDiskApiPath(path, useAppFolder)` + флаг в конструкторе `YandexDiskProvider`
- [x] Upload — двухэтапный (сначала получить upload URL, потом PUT)
- [x] Нет нативного `If-Match` при upload → сверка etag/md5 до upload при `ifMatch` в `ICloudProvider`
- [x] `md5` верификация целостности после upload: `createHash("md5")` от content → сравнение с `etag` из метаданных (если etag — 32-hex md5); при несовпадении → `ProviderError("NETWORK_ERROR")`

---

## Rate Limits

- [x] ~1 000 req / min — `syncRateLimitState` + 429/503 backoff уже реализован
- [x] Mock Яндекс Диск API — integration tests в CI
- [x] ETag workaround логика: `etagFromResource` — `etag` → fallback `md5` (в `yandexDiskProvider.ts`)
- [x] Folder listing и recursive creation: `listFolder` + `createFolder` цепочкой родителей
