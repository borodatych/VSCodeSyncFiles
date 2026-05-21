# Фаза 15: Observability & Debug (v0.9)

> **Цель:** при сообщении «не синкается» команда инженер→пользователь умещается в 1 шаг — «выполните `Profile Sync` / `Explain File Sync State` / `Export Support Bundle` и пришлите zip». Устранить разбросанность каналов вывода, сделать диагностику самообслуживаемой.

**Зависимости:** v0.8 (safety) — корректные ошибки требуются для понятного diagnose
**Следующая фаза:** [16-ux-modern](../16-ux-modern/roadmap.md)

---

## 15.1 Единый OutputChannel + log level (F-010)

- [ ] Свести 5+ существующих каналов (`VSCodeSync · Startup`, `Health Check`, `Profile`, `Sync Preview`, `Потерянные файлы`) в один `VSCodeSync`
- [ ] Setting `vscodesync.log.level`: `error | warn | info | debug | trace` (default `info`)
- [ ] Префикс `[area]` в каждой строке (`[engine]`, `[gdrive]`, `[trigger]`, etc.)
- [ ] Существующие специализированные каналы остаются за фичами (Health Check, Profile Sync) — лог-канал отдельно для трассировки
- [ ] Обновить `verboseLog` → `trace`, `warnLog` → `warn` уровни
- [ ] Команда `vscodesync.openLogChannel`

## 15.2 Support bundle export (F-011)

- [ ] Команда `vscodesync.exportSupportBundle` (deferred — UI wiring + zip)
- [x] Pure-sanitizer `redactSettings` / `redactString` — токены/emails/UUIDs/Bearer/URL-query-params
- [x] `buildSupportBundleManifest` — описание содержимого bundle
- [x] Unit-тесты (`tests/unit/supportBundleSanitizer.test.ts`)
- [ ] Zip содержит:
  - `metadata.json` — версия расширения, VS Code, OS, активный провайдер (без токенов)
  - `settings.redacted.json` — все `vscodesync.*` настройки, секреты вырезаны
  - `activity.last7d.json` — последние 7 дней Activity Feed
  - `health-check.txt` — output последнего Health Check
  - `profile-sync.txt` — dump SyncProfileBuffer
  - `manifest-digest.json` — для каждого workspace: id + note + file count + machines, БЕЗ путей и hash'ей
  - `log.txt` — последние 5000 строк OutputChannel
- [ ] Pure-planner `buildSupportBundleManifest` (что включать)
- [ ] Pure-sanitizer `redactSettings(values)` — вырезает токены, ID, email
- [ ] Output: `~/.vscode/vscodeSync/support-<ts>.zip`, открывает Reveal in File Manager
- [ ] Unit-тесты на sanitizer

## 15.3 Explain file sync state (F-012)

- [ ] Команда `vscodesync.explainFileSyncState <uri>` (deferred — UI wiring)
- [x] Pure-builder `explainFileSyncState(ctx)` — chain из 10 проверок
- [x] `formatExplainReportMarkdown` — рендер для webview / Output
- [x] Unit-тесты (`tests/unit/explainFileSyncState.test.ts`)
- [ ] QuickPick / Markdown panel показывает trace проверок:
  1. Workspace folder trusted? (`isTrusted`)
  2. autoSyncMode = full?
  3. Session pause?
  4. Auto-pause (battery / metered)?
  5. Schedule gate?
  6. Rate limit?
  7. Workspace state (active/suspended/frozen)?
  8. File tracked? (`cfg.files` lookup)
  9. File status (`pending_push`, `cloud_newer`, `conflict`, `editingBy`)?
  10. Last sync attempt + error?
- [ ] Pure-builder `buildSyncStateExplanation(ctx)` без `vscode`
- [ ] Доступ из context menu Explorer (`vscodesync.explainFileSyncState`)
- [ ] Доступ из Workspaces Tree node context

## 15.4 Centralised retry helper (F-013)

- [x] Pure-helper `src/core/withRetry.ts`:
  ```
  withRetry(ctx: { op: string; max: number; jitter: boolean }, fn: () => Promise<T>): Promise<T>
  ```
- [x] Использует существующий `exponentialBackoff.ts`
- [x] Retry-able: `NETWORK_ERROR`, `SERVER_ERROR`, `RATE_LIMITED` (с `retryAfterMs`), `INTEGRITY_FAILED`
- [x] **Не** retry-able: `PRECONDITION_FAILED`, `UNAUTHORIZED`, `NOT_FOUND`, `STORAGE_QUOTA_EXCEEDED`
- [ ] Все провайдеры (gdrive/onedrive/yandex/dropbox) обёрнуть `withRetry` на upload/download/listFolder/delete (deferred — call-site wiring)
- [ ] Проб увеличивает counter в `quotaTracker` (deferred — telemetry)
- [x] Unit-тесты на retry policy + exhaustion (`tests/unit/withRetry.test.ts`)

## 15.5 Status webview tab (F-014)

- [ ] Команда `vscodesync.openStatusPanel` (webview)
- [ ] Содержит:
  - Активный провайдер + статус (online/offline/rate-limited) + autoSyncMode
  - Очередь: pending push, pending pull, conflicts (с deep-link на файл)
  - Последние 20 операций из Activity Feed (filtered: только sync events)
  - Per-provider quota (если известно — после F-002)
  - Sparkline трафика последний час
  - Кнопки Sync Now / Pause / Open Settings
- [ ] Auto-refresh на `vscodesync.activity` event bus
- [ ] HTML renderer pure, ipc через `postMessage`
- [ ] Snapshot test на HTML structure
