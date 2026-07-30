# VSCodeSync v1 — Главный роадмап

> Точка входа. Каждая фаза — самодостаточный модуль, но порядок фаз важен: каждая следующая строится на предыдущей.

## Фазы

| # | Фаза | Описание | Статус |
|---|------|----------|--------|
| 1 | [Foundation](01-foundation/roadmap.md) | Скаффолдинг, конфиги, абстракция провайдера | `[x]` |
| 2 | [Core Sync](02-core-sync/roadmap.md) | OneDrive + workspace + push/pull + конфликты | `[x]` |
| 3 | [UI](03-ui/roadmap.md) | Статус-бар, боковая панель, контекстное меню, онбординг | `[x]` |
| 4 | [Reliability](04-reliability/roadmap.md) | Триггеры, оффлайн-очередь, ETag, rate limits, file lock | `[x]` |
| 5 | [Providers](05-providers/roadmap.md) | Google Drive, Яндекс Диск, Dropbox, переключение | `[x]` |
| 6 | [Power Features](06-power-features/roadmap.md) | Quick Transfer, Watch Mode, Git, Snapshots, Ignore, Шифрование (+ 6.1–6.7 в roadmap) | `[x]` |
| 7 | [UX Polish](07-ux-polish/roadmap.md) | Activity feed, телеметрия, структура | `[x]` |
| 8 | [Platform](08-platform/roadmap.md) | Tasks, CI, compression, Multi-root, CLI… | `[x]` |
| 9 | [Hardening](09-hardening/roadmap.md) | Баг-фиксы из аудита, дедуп PKCE, lint=0, dx-инфра (CHANGELOG/SECURITY/.editorconfig) | `[x]` |
| 10 | [Quick Wins](10-quick-wins/roadmap.md) | Welcome view, Ctrl+Alt+W quick switch, Recently changed sort | `[x]` |
| 11 | [Feature Pack](11-feature-pack/roadmap.md) | Scheduled snapshots, Walkthroughs, AI summary, i18n, presence heartbeat… | `[x]` |
| 12 | [Quality pass](12-quality-pass/roadmap.md) | webviewNonce dedupe, @experimental маркеры, mass-delete guard, queue dedupe, sparkline, online indicator, AI commit message | `[x]` |
| 13 | [Integrations](13-integrations/roadmap.md) | Wiring F1-F5, race-guards, formatNotification, F-3.1..F-3.8 (export, restore, AI path mapper, replay, heatmap, garbage detector, storage report) | `[x]` |
| — | **v0.7 — Performance & autoSyncMode** (без отдельного phase doc, перфоманс-пакет 2026-05-21) | parallelLimit, gdrive folder cache, lazy history, sync profiler, **autoSyncMode** default `check-only`, batched cfg writes, settings panel «Производительность» | `[x]` |
| 14 | [Safety & Recovery](14-safety-recovery/roadmap.md) (v0.8) | Auto-snapshot перед destructive ops, quota exhaustion, repair manifest, re-queue after auth expiry, listFolder pagination, keep-both для конфликтов | `[ ]` |
| 15 | [Observability & Debug](15-observability/roadmap.md) (v0.9) | Единый OutputChannel + log level, support bundle export, `explainFileSyncState`, централизованный retry, status webview tab | `[ ]` |
| 16 | [UX & Modern](16-ux-modern/roadmap.md) (v0.10) | First-run banner для check-only, DnD из Explorer, `vscodesync://` URI scheme, animated decorators, AI Explain Conflict, контекстуальные хинты | `[ ]` |
| 17 | [Finish underbaked](17-finish-underbaked/roadmap.md) (v0.11) | WebRTC P2P signaling round-trip, Passkey recovery codes UI, WASM zstd+BLAKE3 на write-path, AI Bulk Review on push, Sync Replay jump-to-as-of | `[ ]` |
| 18 | [Provider parity](18-provider-parity/roadmap.md) (v0.12) | Dropbox upload session, OneDrive per-chunk retry, resumable downloads, унифицированный post-upload integrity check | `[ ]` |
| 19 | [DX & Quality](19-dx-quality/roadmap.md) (v0.13) | Unit tests на SyncEngine, HTML snapshot tests, contract tests на ICloudProvider, fixture-driven replay, .gitignore watcher, worktree/devcontainer awareness | `[ ]` |
| 20 | [Modern bonus](20-modern-bonus/roadmap.md) (v0.14) | Settings Sync wiring, workspace template marketplace UI, multi-account display, light/dark icon variants, quick switch с sparkline | `[ ]` |
| 21 | [User-visible wiring](21-wiring/roadmap.md) (v0.15) | W01–W14: repair-manifest command, explain-file-state, keep-both context menu, contextual hints scheduler, vscodesync:// URI handler, .gitignore watcher, AI explain conflict, support bundle | `[~]` |
| 22 | [Modern features](22-modern-features/roadmap.md) (v0.16) | N01–N15: SCM-style integration, notebook conflict planner, zip import, webhook digest formatter, cross-machine diff, encrypted-at-rest backups, SBOM report, .syncexclude store, trusted teammates, per-glob schedule, progress estimator, welcome formatter, release notes, conflict timeline, task definitions | `[~]` |
| 23 | [Finish & polish](23-finish-and-polish/roadmap.md) (v0.17 → v0.18) | A1–A13 bug fixes, D01–D06 wiring (provider hash verify, quota banner, withRetry, exportSbom, vscode tasks, trusted teammates), N16–N21 helpers + W1–W6 wiring (invite link commands, connectivity probe widget, schema migrator hook, adaptive concurrency in engine, .vscodesyncrc.json watcher, registry memoisation). Финальная фаза текущей серии v1. | `[x]` |
| 24 | [Audit pass 2026-05-21](24-audit-pass-2026-05-21/roadmap.md) (v0.8) | A1–A3 закрыты до фазы (pull rollback fix). B1–B9 баг-фиксы (deleteBlob, fetch timeouts, dropbox 304, watch poller try/catch, manifest tie-break), U1–U5 UX (keybindings when, command palette cleanup, undo для destructive, single-click auto-mode switch). F1–F8 модные фичи (Smart Pull Digest, cursor-style presence, diff-on-hover, bulk pull, adaptive mode, sync rewind, Telegram digest, "go home"-flow). M1–M5 modern bonus (CDC, S3, BLAKE3 write-path, passkey-only, GH Releases). | `[ ]` |

| 25 | **Стабилизация 1.0.0** (аудит 2026-07-30) | Полный многоагентный аудит: 130 подтверждённых находок + 8 от критика полноты. Семь этапов — см. секцию ниже. Детальный документ: `.cursor/plans/stabilization100.plan.md` | `[~]` |

**Стратегические направления v2:** см. [`docs/v2/roadmap.md`](../v2/roadmap.md)
(WebRTC P2P sync, Passkey unlock, WASM zstd+BLAKE3, cross-cloud backup mirror, декомпозиция `extension.ts`). Конкретные шаги завершения — в Phase 17 выше.

---

## Фаза 25 — стабилизация 1.0.0 (аудит 2026-07-30)

Инвариант, ради которого затевается фаза: **расширение изменяет содержимое файлов —
локально или в облаке — только непосредственно в ответ на явное действие пользователя.**
Всё остальное — чтение и индикация.

- [x] **Этап 0. Инструменты и сетка безопасности** — ✅ (2026-07-30, ветка `next`)
  - [x] Сырые невидимые байты в исходниках заменены на escape-запись: NUL в 4 файлах,
        U+0001 в 2, U+E000 в 1. Из-за NUL git считал `syncEngine.ts` бинарным — `grep`
        без `-a` не находил в нём **ничего**, а `text=auto` не нормализовал переводы строк.
  - [x] `.gitattributes` (`* text=auto eol=lf`) + нормализация дерева: было 312 «изменённых»
        файлов с 52811 идентичными строками и нулём реальных правок.
  - [x] Единый источник правды для id расширения (`src/core/extensionIdentity.ts`).
        В трёх местах UI стоял мёртвый `vscodesync.vscodesync` — «Открыть настройки»
        показывала пустой список.
  - [x] `npm run verify` = typecheck + lint + compile + verify:web + test. Раньше
        `tsc --noEmit` не запускался ни одним скриптом, `verify:web` не вызывался нигде.
  - [x] Интеграционный тест впервые проходит: исправлен id расширения,
        `@vscode/test-electron` 2.5.2 → 3.1.0 (2.x искала бинарь по пути
        `Contents/MacOS/Electron`, VS Code 1.110+ кладёт его как `Contents/MacOS/Code`).
  - [x] CI: `verify` на трёх ОС, `test:integration` под xvfb, запуск на `next` и на PR.
  - [x] Гейты консистентности: настройки ↔ код, `affectsConfiguration` ↔ схема,
        nls en ↔ ru, дефолты README ↔ схема (нашлось 7 расхождений, худшее —
        `gitBranchAutoSync` документировался как `false` при фактическом `true`).
  - [x] `vscodesync.tombstonePurgeDays` объявлена и проведена в deps движка.
  - [x] Support bundle пишет все 7 заявленных файлов вместо 2 и все 98 настроек
        вместо 9; добавлен `runtime-state.json` со снимком очередей и файловых локов.
- [~] **Этап 1. Зависания** — ✅ кроме сквозного `AbortSignal` (план разрешает его после этапа 2)
  - [x] `fetchWithTimeout` снимал таймер на заголовках — тело качалось без дедлайна вовсе;
        собственная копия дефекта у Яндекса удалена.
  - [x] `RequestQueue`: было `concurrency = 1`, `timeoutMs = 0` — сторож не создавался,
        и один незавершившийся запрос вешал всё облачное I/O навсегда. Стало 4 / 150 с /
        потолок очереди, освобождение слота по дедлайну, `reset()` под диагностику.
  - [x] `runWithSyncFileLock`: добавлены дедлайны ожидания и выполнения, очистка карты
        хвостов. При дедлайне выполнения вызывающий получает отказ, но ключ остаётся
        занятым до завершения зависшего тела — второй push поверх недописанного файла
        хуже, чем зависшая операция.
  - [x] `_runWithEngine`: `finally` со сбросом спиннера больше не ждёт закрытия тоста
        (обёртка всех 167 команд).
  - [x] `setSyncing` → счётчик вложенности + watchdog: семь мест гасили спиннер друг другу.
  - [x] Триггеры разделены на две полосы (`src/core/syncTriggerLanes.ts`, чистый модуль,
        7 тестов): пофайловая и полная, полная схлопывает повторы, у каждого шага дедлайн.
  - [x] Pull больше не удаляет запланированный push того же файла — паркует и возвращает.
  - [x] `pruneLocalBackups`: секундная точность имени, троттлинг, разбор времени из имени
        вместо `stat` — было `readdir` + `stat` по всем папкам на каждый скачанный файл.
  - [x] Потолок Retry-After 300 → 60 с (было до ~16 минут на один вызов).
  - [x] Watch Mode: защита от наложения тиков. Dropbox `listFolder`: потолок страниц и
        проверка продвижения курсора вместо `for(;;)` на доверии к серверу.
  - [x] 13 голых `fetch` без `AbortController` переведены на общий хелпер — в том числе
        оба device-code входа и обмен кода на токен во всех трёх провайдерах.
  - [x] `deleteCloudFolderRecursive`: `FileMetadata.isFolder` заполняется всеми четырьмя
        провайдерами вместо пробного `listFolder` на каждый объект.
  - [ ] Сквозной `AbortSignal` до `ICloudProvider` и `cancellable: true`.
- [~] **Этап 2. Корректность push/pull**
  - [x] **Ключ шифрования.** Параметр `encKey` удалён из `makeEngine` целиком — фабрика
        владеет ключом сама (`registerEncryptionKeyRefresh`: прогрев при активации,
        обновление по настройке и по `secrets.onDidChange`). В движке появился
        `encryptionRequired` и `assertEncryptionReady` в `pushFile`/`pullFile`/`pushBlobRaw`:
        «шифрование включено, ключа нет» → отказ, а не тихая работа открытым текстом.
        До правки ключ доезжал в 7 местах из 24, и все автотриггеры шли без него.
  - [x] CLI собирал движок вообще без `encrypt`/`decrypt` — `vscodesync pull` клал
        шифротекст поверх рабочих файлов. Ключ передаётся через переменные окружения,
        объявленное шифрование без ключа отклоняется.
  - [x] **Хэш облачной версии.** Четыре места сравнения хэшировали скачанное тело как
        есть, то есть в проводном виде — при шифровании или сжатии совпасть с
        `_meta.hash` (всегда хэш открытого текста) оно не могло никогда, и файл вечно
        числился конфликтующим. Обратный конвейер вынесен в чистый
        `src/core/cloudBlobCodec.ts` (11 тестов), движок делегирует ему все девять мест.
  - [x] **`addFiles`** заливал сырые байты через `pushBlobRaw` — без сжатия, без
        шифрования, на путь без `.gz`, — а затем скачивал блоб целиком заново только
        ради etag. Переведён на общий конвейер; `pushBlobRaw` удалён.
  - [x] **`.gz`-осведомлённые пути:** переименование (строило новый путь без суффикса,
        а строку `_meta` переносило вместе с `wireGzip: true` → NOT_FOUND навсегда),
        merge (молча пропускал сжатые блобы), evacuate (мнимо успешное удаление,
        блобы оставались мусором), экспорт в папку (плюс честный счётчик — `done++`
        стоял вне `try`, и прогресс досчитывал до 100 % при нуле скачанных файлов).
  - [x] **Авто-отвязка воркспейса.** Повреждённый манифест был неотличим от удалённого:
        оба давали `null`, а `null` читается как «удалено другой машиной» и приводит к
        локальной отвязке со стиранием трекинга. Теперь битое тело бросает
        `ManifestCorruptError`, а `null` остаётся только для честного NOT_FOUND.
        Массовые операции фильтруются по `providerType`: воркспейс чужого облака
        попадал ровно в эту ветку.
  - [x] **Единый владелец `vscodesync.json`.** Около пятнадцати мест делали открытый
        read-modify-write против файла; при `sync.workspaceConcurrency = 2` шаги
        чередуются и вторая запись выбрасывает результат первой. Плюс имя temp-файла
        атомарной записи не было уникально в пределах миллисекунды — два писателя
        получали один путь. Введены `workspaceConfigFile` (сырой диск) и
        `workspaceConfigStore` (владелец на корень: одна копия в памяти,
        сериализованная очередь, проверка свежести по mtime), а
        `WorkspaceConfigManager` стал фасадом над стором — обойти владельца больше
        нечем. 6 тестов, включая 20 конкурентных mutate без потерь.
  - [x] **Пофайловая изоляция в `pushAll`.** Файл, удалённый с диска, давал ENOENT в
        `computeHash`, колбэк отклонялся, и остальные файлы воркспейса не уходили
        вовсе. Теперь сбой пишется в `failedFiles` и показывается отдельным разделом
        сводки. Отказы уровня воркспейса (Suspend, Freeze, машина не подтверждена)
        выделены типом `WorkspacePolicyError` и по-прежнему роняют воркспейс целиком —
        иначе он рапортовал бы успех.
  - [ ] Единый резолвер tracked-пути (19 мест), C8 (устаревший хэш под локом),
        C9 (бинарные файлы), C12, C15, C16, D1, D3, D4, D9.
- [ ] **Этап 3. Политика «ничего без спроса»** — `mutationPolicy` как единственный чекпоинт,
      фон только как детектор расхождений, панель «Расхождения», миграция настроек.
- [ ] **Этап 4. Провайдеры** — классификатор HTTP-статуса, мьютекс refresh, Яндекс на
      code+PKCE, квоты и троттлинг.
- [ ] **Этап 5. Рефакторинг ядра** — `syncEngine.ts` 4157 строк → оркестратор < 600 строк
      плюс слои `plan/` и `io/`.
- [ ] **Этап 6. Поверхность и релиз** — сокращение палитры, документация, версия 1.0.0.

---

## Ключевые архитектурные решения (зафиксировано)

- **Один активный провайдер** глобально (v1). Несколько одновременных — v2+.
- **`.vscode/vscodesync.json`** — машино-специфичный кэш, не источник истины. Источник истины — `.vscodesync-workspace.json` на облаке.
- **Manifest-first**: манифест workspace'а синхронизируется раньше файлов.
- **Lamport timestamps** (`version`) в манифесте для разрешения гонок при merge.
- **ETag + `If-Match`** для атомарных PUT файлов и `_meta.json`.
- **Canonical pipeline**: `normalize_line_endings → sanitize_syncignore → SHA-256 → [compress] → [encrypt] → upload`
- **Хэш** всегда от нормализованной санированной версии (одинаков на Windows/Linux).
- **Теги** как отдельное поле `tags[]` в манифесте (не парсинг из названия).
- **gitBranch** хранится в облачном манифесте (одинаково на всех машинах).
- **Multi-root workspace**: каждая папка независима, свой `vscodesync.json`.

---

## Структура облачного хранилища (справка)

```
VSCodeSyncFiles/
  {workspaceId}/
    .vscodesync-workspace.json   ← манифест (состав файлов, теги, ветка, машины)
    _meta.json                   ← последнее синхронизированное состояние файлов (hash, version)
    .history/{path}/             ← история версий (до 10 версий, настраивается)
    .snapshots/{name}/           ← снапшоты workspace'а
    {файлы...}
  _quicktransfer/{uuid}/         ← разовые передачи
  _machines.json                 ← реестр всех машин
```

---

## Структура локальных конфигов (справка)

```
~/.vscode/vscodeSync/
  config.json          ← activeProvider, machineId, machineName, токены
  stats.json           ← статистика (локально)
  activity.json        ← лог событий (локально, 90 дней)
  queue.json           ← оффлайн-очередь автосинка (fullSync / push / pull)
  schedule-deferred.json ← отложенные операции вне окна расписания
  {hash}.lock          ← lock-файл для параллельных окон VSCode

{project}/.vscode/
  vscodesync.json      ← activeWorkspaces, files (кэш, не источник истины)

{project}/
  .vscodesync-ignore   ← паттерны исключений (gitignore-синтаксис)
```
