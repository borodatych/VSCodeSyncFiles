# Фаза 18: Provider parity (v0.12)

> **Цель:** один и тот же contract для всех 4 провайдеров. Сейчас OneDrive имеет resumable upload, Yandex имеет md5 integrity check, Dropbox имеет cursor pagination — и каждый по-своему. Привести к единому уровню reliability.

**Зависимости:** v0.11 (некоторые проверки используют BLAKE3 из 17.3)
**Следующая фаза:** [19-dx-quality](../19-dx-quality/roadmap.md)

---

## 18.1 Dropbox upload session API для больших файлов (F-040)

Dropbox API: файлы >150 МБ требуют `/files/upload_session/start` + `_append_v2` + `_finish`. Сейчас один POST → 413 на большие файлы.

- [x] Pure planner `planDropboxUpload(byteLength, opts)` — chunks с endpoint kinds (start/append_v2/finish)
- [x] Threshold + chunk size настраиваются (default 150MB / 8MB), clamping безопасный
- [x] Single-shot collapse когда session дал бы только 1 chunk
- [x] Unit-тесты на edge cases (`tests/unit/dropboxUploadSessionPlanner.test.ts`)
- [ ] `dropboxProvider.uploadFile` интеграция: при threshold → walk plan.chunks (deferred — provider wiring)
- [ ] Setting `vscodesync.dropbox.uploadSessionThresholdMB` / `uploadChunkMB` (deferred — package.json + wiring)
- [ ] Per-chunk 5xx retry через `withRetry` (F-013) (deferred)
- [ ] Mock provider test: simulate 100MB file → ровно один session, N чанков (deferred)

## 18.2 Per-chunk 5xx retry в OneDrive upload session (F-041)

`onedriveProvider.uploadLargeFile` — текущая реализация не retry'ит chunk на 5xx, throw'ает.

- [ ] Обернуть каждый chunk через `withRetry` (макс 3 попытки, exp backoff с jitter)
- [ ] При retry: проверить `Range:` header в ответе сервера для resume from server's last-known offset
- [ ] Setting `vscodesync.onedrive.uploadChunkRetries` (default 3)
- [ ] Mock test: simulate 503 на chunk #2 → retry успех на 2-й попытке

## 18.3 Resumable downloads (Range) (F-042)

Сейчас прерванная загрузка → перезапуск с 0 байт. На медленных каналах с большими файлами — критично.

- [ ] Расширить `DownloadOptions`: `rangeFromByte?: number`
- [ ] Все 4 провайдера: при наличии `rangeFromByte` → `Range: bytes=N-`
- [ ] В `pullFile`: если download прервался (network error) и > 50% уже скачано — retry с `Range:` от последнего offset
- [ ] Track progress через `onTransfer` события
- [ ] Setting `vscodesync.resumableDownloads` (default `true`)
- [ ] Acceptance: 100MB файл, сетевой drop на 50MB → resume from 50MB

## 18.4 Унифицированный post-upload integrity check (F-043)

- [x] Pure helper `providerHashVerify.ts`:
  - [x] `md5Hex` / `sha1Hex` / `sha256Hex` (GDrive `md5Checksum`, Yandex `md5`, OneDrive вариативные)
  - [x] `dropboxContentHash` — SHA-256 chained-4MB-blocks (RFC из docs)
  - [x] `expectedProviderDigests(provider, buf)` — что ожидать от каждого провайдера
  - [x] `digestEquals` constant-time
- [x] `ProviderError.code = "INTEGRITY_FAILED"` уже в enum (см. F-002)
- [x] Unit-тесты с known vectors (`tests/unit/providerHashVerify.test.ts`)
- [ ] Wire в `pushFile`: после upload вызвать `provider.getMetadata(cloudPath)` и сравнить (deferred — provider-side wiring)
- [ ] Setting `vscodesync.providerHashVerify` (default `true`) (deferred)
