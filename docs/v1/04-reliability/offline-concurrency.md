# Оффлайн, Concurrency, Rate Limits

> Детальная спецификация: оффлайн-очередь, exponential backoff, глобальная очередь запросов, ETag concurrency.

**Часть фазы:** [04-reliability](roadmap.md)

---

## Оффлайн-очередь

- [x] При отсутствии сети: операции push/pull ставятся в очередь (persisted в `~/.vscode/vscodeSync/queue.json` — `SyncOfflineQueueStore`, вызовы из триггеров / `quietFullSync` / OneDrive `graphFetch`)
- [x] Статус-бар: индикатор Offline + счётчик queued (`statusBar.ts`, `subscribeOfflineHints`)
- [x] Определение сети — два механизма:
  1. **Активный**: неудачный запрос к облаку → `NETWORK_ERROR` / errno + sticky hint (`syncOfflineHints`) и backoff между попытками flush: 15s → 30s → … max 5min (`syncOfflineFlushBackoff`, см. также rate-limit backoff)
  2. **Пассивный**: `navigator.onLine` / `readPassiveOnlineHint` — доп. триггер «сеть могла появиться» (`syncOfflineRecoveryMonitor`)
- [x] При восстановлении: `registerOfflineRecoveryMonitor` вызывает `flushOfflineQueue` (fullSync → тихий полный цикл; file ops через движок)
- [x] Quick Transfer в очереди: перед исполнением flush проверка `queuedAtIso` + `ttlDays` (та же логика, что `sentAt` + TTL в облаке); при истечении — не отправлять, предупреждение в UI; ручная отправка при оффлайне — `enqueueQuickTransferSend` (`quickTransferUi.ts`)
- [x] Unit-тесты: классификация unreachable (`tests/unit/networkErrors.test.ts`), merge/dedupe/персистентность очереди (`tests/unit/syncOfflineQueueStore.test.ts`); интеграционный сценарий flush order с мок-провайдером — позже

---

## Exponential Backoff

- [x] Реализовать `ExponentialBackoff(initialMs, factor, maxMs)` — `src/core/exponentialBackoff.ts` (fallback при 429 без `Retry-After` в `syncRateLimitState`)
  - Дефолты: 15s → 30s → … max 5 мин.
- [x] При 429 `Too Many Requests`: уважать `Retry-After` заголовок — `src/utils/retryAfter.ts`, OneDrive `graphFetch`
- [x] При 412 `Precondition Failed` (ETag mismatch): retry с свежими данными (не backoff — сразу) — как раньше в движке / провайдере
- [x] При сетевой ошибке (unreachable): backoff между попытками flush оффлайн-очереди (`syncOfflineFlushBackoff`); очередь — выше
- [x] Unit-тест: sequence (`exponentialBackoff.test.ts`, `retryAfter.test.ts`, `syncRateLimitState.test.ts`)

---

## Глобальная очередь запросов

- [x] `RequestQueue` — все операции (Watch Mode, onSave push, onFocus pull) идут через одну очередь (`queuedProvider.ts` оборачивает провайдер; `makeEngine` использует `wrapWithQueue`)
- [x] Rate limiter: отслеживать количество запросов за окно времени (по провайдеру) (`noteProviderApiRequest` + `getProviderRequestCount` + `isApproachingRateLimit` в `syncRateLimitState.ts`)
- [x] Лимиты (приблизительно): `PROVIDER_RATE_LIMITS` в `syncRateLimitState.ts`
  - OneDrive: 10 000 req / 10 min
  - Google Drive: 1 000 req / 100 sec
  - Яндекс Диск: 1 000 req / min
- [x] Предупреждение в настройках если `watchIntervalSeconds < 30`: `onDidChangeConfiguration` → `showWarningMessage` в extension.ts
- [x] Статус-бар при rate limit: индикатор + «~Ns» (`SyncStatusBarController`)
- [x] Пауза **автосинка** при активном throttle: `quietFullSyncAllFolders`, `syncTriggerManager.withEngine`, `watchModePoller`, отложенный flush возвращает snapshot в store
- [x] Стратегия батчинга Watch Mode:
  1. [x] Сначала проверить манифест (`updatedAt`) с Conditional GET (If-None-Match) — если `304 Not Modified` → файлы не трогать
  2. [x] Если манифест изменился → скачать только изменённые файлы (по hash в `syncOneFile`)
- [x] Unit-тест: N одновременных операций → сериализованы через очередь (`tests/unit/requestQueueConcurrency.test.ts`, 6 тестов)

---

## ETag Concurrency Control (файлы)

- [x] При Pull: `dl.etag` из ответа сохраняется в `_meta.files[posixRel].etag` (`pullFile` в syncEngine)
- [x] При PUT: `If-Match: meta.files[posixRel].etag` из предыдущего pull (`pushFile`, `ifMatchBlob = pathModeChanged ? undefined : prevEtag`)
- [x] При `412 PRECONDITION_FAILED`: `file.syncStatus = "conflict"` + `onNewConflict` callback
- [x] Маппинг: все провайдеры возвращают `etag` в `UploadResult`/`DownloadResult`

---

## Верификация после upload

- [x] После каждого PUT: `verifyUploadPlaintextHash` — скачивает blob, сравнивает hash
- [x] При несовпадении: retry × `VERIFY_RETRIES = 3`
- [x] При неустранимом несовпадении: `throw new Error("verifyUploadPlaintextHash: hash mismatch after retries")`
- [x] При включённом шифровании: верификация отключена (зашифрованный blob ≠ plaintext hash)

---

## Уведомление об истечении токена

- [x] При `invalid_grant` / `UNAUTHORIZED` (протухший или отсутствующий токен):
  - [x] `runWithEngine` перехватывает `ProviderError.UNAUTHORIZED` → `showErrorMessage` с кнопкой «Войти снова» → `setActiveProvider`
  - [x] OneDrive startup check: если `expiresAtMs < Date.now()` → `showWarningMessage` + «Войти снова»
  - [x] Синхронизация блокируется, изменения в оффлайн-очередь — автоматически (`syncTriggerManager.withEngine` перехватывает `UNAUTHORIZED` → `enqueueFullSync`)
- [x] За 7 дней до `expiresAt` — `src/core/tokenExpiryHints.ts` (`classifyExpiry` + `formatExpiryHint`, 11 unit-тестов: ok / expiring_soon / expired, custom warn window, non-finite timestamps) подключён в OneDrive startup-loop ([extension.ts:4754](src/extension.ts#L4754)): хранится `bundle.expiresAtMs` (access-token TTL); `formatExpiryHint("OneDrive", hint)` показывает warning-toast при `expiring_soon` / `expired`.

---

## Адаптивный интервал Watch Mode

- [x] После 5 consecutive idle-циклов → удвоить интервал (до `watchMaxIntervalSeconds`)
- [x] При обнаружении изменений → сбросить к `watchIntervalSeconds` (`runQuietFullSyncAllFolders` возвращает `boolean` — сравнение `lastSync` до/после)
- [x] Статус-бар: `$(eye) Watch · Nmin (idle)` при удвоении (в `statusBar.ts`)
- [x] `vscodesync.watchAdaptive: false` — отключить
