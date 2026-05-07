# Провайдер: Google Drive

> Google Drive API v3.

**Часть фазы:** [05-providers](roadmap.md)  
**Реализация:** `src/providers/gdrive/gdriveProvider.ts`, `src/providers/gdrive/gdriveDeviceCode.ts`

---

## OAuth 2.0

- [x] Device Code Flow (`gdriveDeviceCode.ts`): `POST /device/code` → polling → токены в `vscode.SecretStorage`
- [x] Auto-refresh access token: `maybeRefreshAccessToken` перед каждым запросом (skew 5 мин)
- [x] Настройка: `vscodesync.googleDriveClientId`
- [x] Authorization Code Flow с PKCE — `src/providers/gdrive/gdrivePkceOAuth.ts`: loopback 127.0.0.1:8737, S256, `runGdrivePkceOAuth`; `access_type=offline` + `prompt=consent` для refresh_token

---

## Google Drive API v3

- [x] Файловые ID маппятся через `_id-map.json` в корне `VSCodeSyncFiles/`
- [x] **Upload**: multipart upload для новых файлов; patch для обновлений
- [x] **Download**: `GET /files/{id}?alt=media`; Conditional GET через `If-None-Match`
- [x] **Metadata**: `GET /files/{id}?fields=id,name,md5Checksum,modifiedTime,etag`
- [x] **Delete**: `DELETE /files/{id}`
- [x] **List folder**: `GET /files?q=...&fields=...`
- [x] ETag: заголовок `ETag` / поле `etag`
- [x] Rate limits 403/429 → backoff (`syncRateLimitState`)
- [x] Webhooks: `POST /files/watch` (`gdrivePushChannelApi.ts`, `googleDriveWebhookLifecycle.ts`)
