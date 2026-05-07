# Провайдер: Dropbox

> Dropbox API v2.

**Часть фазы:** [05-providers](roadmap.md)  
**Реализация:** `src/providers/dropbox/dropboxProvider.ts`, `src/providers/dropbox/dropboxPkceOAuth.ts`

---

## OAuth 2.0

- [x] Authorization Code Flow с PKCE + loopback callback (`dropboxPkceOAuth.ts`)
- [x] Токены в `vscode.SecretStorage`; авто-refresh (`maybeRefreshAccessToken` перед запросом)
- [x] Настройка: `vscodesync.dropboxAppKey`; redirect `http://127.0.0.1:8734/oauth-callback`

---

## Dropbox API v2

- [x] **Upload**: `POST /2/files/upload`; mode `update` с `rev` для optimistic locking
- [x] **Download**: `POST /2/files/download`; If-None-Match через кэш `rev`
- [x] **Metadata**: `POST /2/files/get_metadata` → `rev` как ETag, `size`, `content_hash`
- [x] **Delete**: `POST /2/files/delete_v2`
- [x] **List folder**: `POST /2/files/list_folder`
- [x] ETag = поле `rev`; при `conflict` (устаревший rev) → conflict flow
- [x] Rate limit 429 → backoff

---

## Особенности

- [x] Dropbox path-based (не fileId) — `cloudPath` используется напрямую
- [x] `rev` обновляется при каждом изменении — надёжный optimistic lock
