# Фаза 8: Platform

> **Цель:** расширение платформы за пределы основного VSCode. CLI-компаньон, web extension, webhooks, delta sync, Tasks API.

**Зависимости:** [07-ux-polish](../07-ux-polish/roadmap.md) ✅  
**Финальная фаза v1**

---

## Модули этой фазы

| Модуль | Файл | Статус |
|--------|------|--------|
| CLI-компаньон | [cli.md](cli.md) | `[~]` |
| Web Extension | [web-extension.md](web-extension.md) | `[~]` |

---

## 8.1 Webhooks (push-уведомления вместо polling)

> Замена Watch Mode polling. Резко снижает нагрузку на API.

- [x] `vscodesync.webhooks.enabled: false` (умолч) — в `package.json`
- [x] `vscodesync.webhooks.url` — публичный HTTPS endpoint (поле в настройках)
- [x] `vscodesync.webhooks.fallbackAfterMinutes` (умолч. 5; 0 = не уходить в polling из‑за тишины уведомлений)
- [x] **OneDrive**: `POST /subscriptions` (Microsoft Graph), renew, delete при смене провайдера / выключении; локальный сервер validation + уведомлений (`graphWebhookLocalServer.ts`, `oneDriveWebhookLifecycle.ts`, `graphWebhookSubscription.ts`) + общий push-статус [`webhookChannelCoordinator.ts`](../../../src/ui/webhookChannelCoordinator.ts)
- [x] **Google Drive**: `POST /files/watch` на корневую папку `VSCodeSyncFiles`, `channels/stop`, renew до истечения; состояние в `gdrive-push-channel.json` ([`gdrivePushChannelApi.ts`](../../../src/providers/gdrive/gdrivePushChannelApi.ts), [`googleDriveWebhookLifecycle.ts`](../../../src/ui/googleDriveWebhookLifecycle.ts))
- [x] При включении: зарегистрировать подписку → получать уведомления об изменениях *(OneDrive — да, при валидном публичном URL + локальный listener или relay)*
- [x] Если webhook недоступен / **тишина** push > `webhooks.fallbackAfterMinutes` → снова interval polling + предупреждение (`webhookWatchModePolicy.ts`, `watchModePoller.ts`)
- [x] Встроенный smee.io туннель как опция (`vscodesync.webhooks.tunnelEnabled`): `createAndStartSmeeRelay` / `startSmeeRelay` в `src/ui/webhookTunnel.ts`; интегрирован в `oneDriveWebhookLifecycle.ts`
- [x] При активной подписке Watch Mode interval polling отключается, пока push «свежий» (`isWebhookWatchPollingSuppressed()` + `watchModePoller.ts`)

---

## 8.2 Delta Sync (v1.5+)

> Загружать только изменённые части файла. Для файлов > `deltaThresholdKB`.

- [x] `vscodesync.deltaSync: false` (умолч) — в `package.json`; проброс в `SyncEngine` (`extension.ts` → `makeEngine`)
- [x] `vscodesync.deltaThresholdKB: 100` — в `package.json`; порог в [`deltaSyncGate.ts`](../../../src/core/deltaSyncGate.ts)
- [x] Алгоритм (client-side): `computeChunks` (CDC rolling-hash, Rabin-Karp) + `computeDelta` + `applyDelta` + `deltaApplyFromCloud` в `src/core/deltaSyncGate.ts`
- [x] Delta Sync + Compression: `deltaApplyFromCloud(cloudBuf, localBuf, wireGzip)` — распаковка gzip перед диффом
- [x] Для файлов < порога: стандартный полный upload
- [x] Unit-тесты: `deltaSyncGate.test.ts`; интеграционный тест «большой файл → 1 GET + 1 PUT» в `deltaSyncAlgorithm.test.ts`

---

## 8.3 VSCode Tasks Integration

- [x] Зарегистрировать `TaskProvider` для типа `vscodesync`
- [x] Поддерживаемые task-значения: `push`, `pull`, `push-all`, `pull-all`, `create-snapshot`
- [x] Пример `tasks.json`:
  ```json
  {
    "type": "vscodesync",
    "task": "pull",
    "workspace": "a3f8c1d2",
    "label": "Pull latest from cloud",
    "runOptions": { "runOn": "folderOpen" }
  }
  ```
- [x] Интеграция с pre/post build pipeline — через стандартные compound tasks и [`dependsOn` в `tasks.json`](https://code.visualstudio.com/docs/editor/tasks#_compound-tasks); отдельный код расширения не требуется

---

## 8.4 Compression (`compressUploads`)

- [x] `vscodesync.compressUploads: false` (умолч)
- [x] Алгоритм: gzip (`node:zlib`); Web extension — см. roadmap Web (отдельно)
- [x] Только текстовые файлы (`isProbablyBinaryPath` / `bufferLooksBinary`; при «неудачном» gzip размер проверка — не грузить)
- [x] Сжатые файлы: путь blob = канонический `trackedFileCloudPath` + суффикс `.gz`; в `_meta.files[pos].wireGzip`
- [x] В Stats: `bytesSavedByCompressionMonth` через `recordCompressionSaving` (экономия ≈ plaintext − gzipplaintext)
- [x] При включённом **шифровании** workspace gzip отключается (движок); Delta Sync + Compression — см. §8.2

---

## 8.5 Multi-root Workspace

- [x] Каждая корневая папка в `.code-workspace` обрабатывается независимо
- [x] Свой `.vscode/vscodesync.json` для каждой корневой папки
- [x] Боковая панель группирует по корневой папке:
  ```
  ▼ 📁 MyApp (корень 1)
       ✅ MyApp — авторизация
  ▼ 📁 Shared Libs (корень 2)
       ✅ Shared — утилиты
  ```
- [x] Определять `workspaceRoot` через `vscode.workspace.workspaceFolders[n]` и `getWorkspaceFolder(uri)` (`resolveDefaultWorkspaceRootFsPath` / `resolveWorkspaceRootForPaletteCommand` в `src/utils/workspaceRootResolver.ts`)

---

## Критерий готовности фазы (и v1 в целом)

- [x] CLI-компаньон работает без открытого VSCode ([cli.md](cli.md): `status`, `pull` / `pull-all`, OneDrive + `VSCODESYNC_TOKEN`; прочие провайдеры и keytar — дальше)
- [x] Web extension активируется на `vscode.dev` / `github.dev` — заглушки команд + дерево Workspaces + `UriHandler` для OAuth; полный sync остаётся в Desktop ([web-extension.md](web-extension.md))
- [x] Tasks integration работает в `tasks.json`
- [x] Compression снижает размер uploads для текстовых файлов (gzip + `wireGzip` в `_meta`; без шифрования)
- [x] Все 8 фаз завершены → **v1 готова к публикации в Marketplace**

---

## CI/CD для публикации

- [x] GitHub Actions PR/push: `tests → lint → compile → integration → package` ([`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml))
- [x] Релиз по тегам `v*`: сборка, GitHub Release с `.vsix`, опционально `vsce publish` при секрете [`VSCE_PAT`](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) ([`.github/workflows/release.yml`](../../../.github/workflows/release.yml))
- [x] Отдельные entrypoints: `esbuild.mjs` собирает `dist/extension.js` (node) и `dist/extension.web.js` (browser); проверка наличия обоих бандлов в CI
- [x] `.vscodeignore` настроен (исключить `src/`, `tests/`, `docs/` из VSIX)
