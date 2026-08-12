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
- [x] **Этап 1. Зависания** — ✅ полностью (сквозной `AbortSignal` закрыт 2026-08-06)
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
  - [x] **Сквозной `AbortSignal` (A5)** — ✅ (2026-08-06, ветка `next`).
        `core/operationCancelled.ts`: `OperationCancelledError`, `throwIfAborted`,
        `isAborted`, `isCancellation`, `sleepUnlessAborted`. Путь сигнала:
        команда → `runWithEngine({ cancellable })` → `withProgress` с рабочей
        кнопкой «Отмена» → `EnginePorts.abortSignal` → циклы движка (между
        файлами и между воркспейсами в `pushAll`/`pullAll`/`syncWorkspace`/
        детекторе) → `UploadOptions.signal` / `DownloadOptions.signal` →
        обёртки четырёх провайдеров → `withRetry` → `fetchWithTimeout`, который
        умел принимать сигнал с самого начала, но никто его не передавал.
        Бэкофф между попытками прерывается отменой, а не досыпает до конца.
        `Retry-After` ограничен сверху 60 с (`MAX_HONOURED_RETRY_AFTER_MS`):
        просьба провайдера подождать минуты больше не превращает одну команду
        в многоминутную заморозку — операция завершается, а паузу держит
        rate-limit-гейт. Отмена не считается ошибкой: `runWithEngine` показывает
        «операция отменена», а не диалог сбоя. Команды с отменой: Push All,
        Pull All, Push/Pull/Sync workspace. 8 тестов.
- [x] **Этап 2. Корректность push/pull** — ✅ (2026-07-30, ветка `next`)
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
  - [x] **D4 — защита от массового удаления спрашивала слишком поздно.**
        `removeTrackedFiles` удалял облачные блобы прямо в цикле, а guard срабатывает
        внутри `putManifest`. К моменту вопроса «будет удалено 500 файлов?» все 500
        были уже удалены, и ответ «нет» оставлял данные стёртыми при нетронутом
        манифесте. Теперь два прохода: сначала вычисляем будущий манифест и
        спрашиваем, затем удаляем.
  - [x] **D3 — оффлайн-очередь теряла элементы.** Очередь опустошается `drainSnapshot`
        до выполнения, а каждая пофайловая ошибка глоталась `catch { /* best-effort */ }`:
        элемент исчезал навсегда, пользователь читал «обработано N элементов».
        Теперь пропажа сети возвращает хвост в очередь и прекращает флаш, прочие
        ошибки возвращаются в очередь и показываются, а счётчик их не считает.
  - [x] **C9 — бинарные файлы пропадали молча.** Настройка `warnOnBinaryFiles`
        обещает предупреждение, но все четыре автоматических пути просто делали
        `return`. Файл не отправлялся автоматически никогда — без статуса, уведомления
        и записи в журнале. Добавлен `binarySkipNotice` (7 тестов): первый пропуск
        объявляется, повторные молчат.
  - [x] **C8 — в `_meta` уходил хэш старого содержимого.** Под локом читался свежий
        буфер, но записывался хэш, посчитанный до взятия лока; пересчёт был обусловлен
        сравнением длины только что прочитанного буфера с размером только что снятого
        `stat` того же файла — то есть не срабатывал никогда. Теперь хэшируется тот
        самый буфер, который отправляется.
  - [x] **D1 — ротация ключа могла оставить файлы нечитаемыми навсегда.** Сбой снапшота
        был «non-fatal», сбой перешифровки файла глотался, а новый ключ сохранялся
        безусловно — пропущенный файл оставался под затёртым ключом. Теперь: экспорт
        старого ключа предлагается до старта, сбой снапшота отменяет операцию, ключ
        сохраняется только при полном успехе, иначе выполняется откат под старый ключ;
        при частичном откате побеждает новый ключ и пользователь получает поимённый
        список файлов и снапшот для восстановления.
  - [x] Проверка гигиены исходников добавлена в pre-commit: гейт существовал, но
        выполнялся только в `npm run verify`, и сырой байт проскочил в коммит.
  - [x] **D9 — несозданный снапшот пропускал массовое изменение.** Кнопка «Создать
        snapshot и продолжить» вызывала команду, результат которой ничего не сообщал:
        отмена и сбой были неотличимы от успеха, и операция шла дальше под
        комментарием «пользователь явно согласился продолжить». Снапшот теперь
        создаётся напрямую, при сбое задаётся отдельный вопрос, и всё кроме явного
        подтверждения отменяет операцию.
  - [~] **C13 — единый резолвер tracked-пути.** `pathMapping` игнорировался ручными
        `path.join`/`path.relative` примерно в двух десятках мест: при заданном
        отображении отслеживаемый файл читается как «не в синхронизации», значок
        пропадает, команды над ним ничего не делают. Введён
        `src/core/trackedPathResolver.ts`; переведены места с этим симптомом —
        значки в Проводнике, context-ключи редактора, CodeLens, hover-диф,
        presence, предсказание конфликтов. Гейт
        `tests/unit/trackedPathResolverUsage.test.ts` перечисляет непереведённые
        поимённо и роняет тест на новом обходе.
  - [x] **C12 — принятые из чужого манифеста файлы считались синхронизированными.**
        Регистрировались со статусом «ok» и с ОБЛАЧНЫМ хэшем в `localHash`, поэтому
        никогда не скачивались, — при том что локально их могло не быть вовсе; плюс
        `cloudPath` строился без `.gz`. Теперь путь берёт `wireGzip` из `_meta`, а
        статус зависит от наличия файла на диске.
  - [x] **C15 — «Push … готово» при нуле отправленного.** Добавлен
        `summarisePushForToast`: число отправленных, отдельно пропущенные файлы и
        упавшие папки. 7 тестов.
  - [x] **C16 — асимметрия контракта на конфликте.** `pushFile` тихо возвращал void,
        `pullFile` бросал безымянную ошибку. Введён `FileConflictError`, оба метода
        ведут себя одинаково.
  - [x] Список непереведённых мест в гейте резолвера сокращён с шестнадцати до
        девяти: переведены все, печатающие «файл не в синхронизации».

**Этап 2 закрыт.** Остаток — девять мест в гейте резолвера, где ручное
преобразование пути не даёт видимого симптома; переносится в этап 5 вместе с
выделением слоёв.
- [~] **Этап 3. Политика «ничего без спроса»** — `mutationPolicy` как единственный чекпоинт,
      фон только как детектор расхождений, панель «Расхождения», миграция настроек.
  - [x] **3.1 (F2) — единый чекпоинт мутации** — ✅ (2026-07-31, ветка `next`)
    - [x] `src/core/syncPolicy.ts`: `SyncTrigger`, рантайм-список `MUTATION_OPS` (37 операций),
          чистая `mutationPolicy(op, trigger)`, `MutationDeniedError`, `assertMutationAllowed`.
          Политика **не** инжектится через deps, как предлагал план: инжектируемая политика —
          это следующий bypass-параметр. Движок импортирует функцию напрямую.
    - [x] `SyncEngineDeps.trigger` — **обязательное** поле; `makeEngine` получил обязательный
          пятый аргумент. Компилятор спросил все 23 места сборки движка и 21 объявление типа.
          Урок `encKey` (необязательный параметр забыли в 17 местах из 24) не повторяется.
    - [x] 37 вызовов `assertMayMutate` первой строкой мутирующих методов. Не гейтятся
          `setWorkspaceSyncState` (только локальный `syncState`, нужен смене git-ветки),
          `adoptManifestFilesFromCloud`/`pruneTrackingFromManifest` (детекторный путь),
          `downloadManifest`/`pullMeta` (обновление кэша etag).
    - [x] Слив отложенных снимков истории в начале `syncWorkspace` заливал блобы в облако
          **до** проверки `checkOnly` — то есть фоновый статус-проход отправлял данные.
          Теперь очередь переживает фоновый тик и сливается на ближайшем пользовательском.
    - [x] Авто-отвязка воркспейса при NOT_FOUND манифеста больше не выполняется фоном:
          находка сообщается, решение (залить обратно / отключить локально) за пользователем.
          Раньше фоновый тик стирал воркспейс и весь его трекинг из `vscodesync.json`.
    - [x] Все четыре `bypass*` удалены (`bypassSchedule`, `bypassAutoPause`, `bypassRateLimit`,
          `bypassAutoSyncMode`). Их общий смысл — «человек попросил, автоматические тормоза
          не применяются» — теперь выражен один раз, полем `trigger`. `bypassAutoSyncMode`
          не передавался ниоткуда: замысел «ручной sync форсирует полный проход в check-only»
          сохранён веткой `trigger === "user"`.
    - [x] Задачи `vscodesync`: `runOn: folderOpen` доходил до `pushAll` без единого гейта, а
          VS Code не даёт отличить автозапуск от ручного. Введена настройка
          `vscodesync.tasks.allowFileMutations` (по умолчанию `false`) — это и есть
          недостающее согласие, выданное заранее.
    - [x] Гейт `tests/unit/mutationPolicyGate.test.ts`: соответствие `MUTATION_OPS` ↔ вызовы
          в движке, отсутствие условных гейтов кроме названных, невозврат `bypass*`,
          явный триггер на каждом вызове `makeEngine`, единственный центр решения внутри
          `src/core/`, и список модулей, которым разрешено умолчание `"user"` в `runWithEngine`.
    - [x] `tests/unit/syncPolicy.test.ts` (матрица операция × триггер) и
          `tests/unit/syncEngineMutationPolicy.test.ts` (поведение движка: отказы,
          ноль байт в облако, работающий детектор).
    - [~] **Названная дыра, закрывается в 3.2.** Гейт `syncWorkspace` условен по
          `options?.checkOnly !== true`: check-only — это детектор, запретить его нельзя.
          Но пролог check-only до сих пор меняет **состав** трекинга — `adoptManifestFilesFromCloud`
          добавляет записи по чужому манифесту, `pruneTrackingFromManifest` удаляет.
          Байты файлов при этом не двигаются. Правильное решение — не гейт, а расцепление:
          дать `checkWorkspaceStatus` собственное тело (B5/B6), тогда чекпоинт
          `syncWorkspace` станет безусловным.
    - [ ] **Найдено при инвентаризации, вне чекпоинта движка** (эти пути движок не строят,
          обязательный `trigger` их не заденет — закрывать отдельно в 3.3):
          плановые снапшоты по таймеру заливают байты каждого tracked-файла **открытым
          текстом** и удаляют облачные объекты по retention (B13); cross-cloud backup по
          таймеру реплицирует дерево снапшотов во второе облако (B12); presence heartbeat
          пишет `_machines.json` и путь редактируемого сейчас файла (B11); Quick Transfer
          удаляет облачные объекты опросом раз в 120 с; `ensureWorkspaceGitignoreEntry`
          дописывает существующий `.gitignore` пользователя при активации без вопроса.
    - [x] **Вне политики мутаций, но найдено тем же проходом:** `p2pFileTransferReceiver`
          делал `path.join(root, manifest.relPath)` без проверки на traversal — закрыто
          (см. 3.3 ниже). Остаток: `commandCenter`/`settingsPanel` выполняют
          `executeCommand(msg.command, ...msg.args)` из webview без allow-list, а
          `vscodeSyncUriHandler` — команду из внешней ссылки до всякого вопроса.
  - [x] **3.2 — фоновые источники переведены в детекторы/предложения** — ✅ (2026-07-31, ветка `next`)
    - [x] **B5/B6 — детектор отделён от `syncWorkspace`.** `checkWorkspaceStatus` получил
          собственное тело (общий пролог — `loadWorkspaceSyncContext`), гейт `syncWorkspace`
          стал безусловным, `CONDITIONAL_GATES` гейт-теста опустел. Adopt/prune на
          детекторном пути заменены отчётом `onTrackingDriftDetected` + операция
          `applyTrackingFromCloud` по кнопке «Применить». Попутно найден и исправлен баг
          когерентности: etag манифеста живёт в общем сторе, тело — в per-instance кэше;
          другой инстанс продвигал etag, и 304 отдавал устаревшее тело (`cacheManifest`
          привязывает тело к etag).
    - [x] **B17/F7 — Push перестал делать pull.** `pushAll` освежает статусы детекторным
          проходом и только выгружает; `pushMetaJson` получил обязательный `reason`
          («push» / «pull-completion»), процессный счётчик `withPullCloudMetaWriteAllowed`
          удалён — пока параллельный pull держал окно, посторонняя запись `_meta` на
          read-only-инстансе проходила проверку.
    - [x] **B1 — смена git-ветки не двигает данные.** Гейт `autoSyncMode` первой строкой
          (off = тишина); безусловный `pullAll` для pending-машины → кнопка «Скачать всё»;
          `syncWorkspace` — только после «Синхронизировать»; fallback «preview упал →
          синкаем» удалён; debounce по корню; модалка при suspend заменена тостом.
    - [x] **B2/B3 — очереди стали списком намерений.** Монитор оффлайн-очереди и переход
          окна расписания показывают одно уведомление «N отложенных операций»
          (Выполнить / Очистить); флаш строит движки из `deps.trigger`, таймерных вызовов
          не осталось.
    - [x] **B4 — Soft-Lock за настройкой.** `vscodesync.softLock.enabled` (default `false`);
          heartbeat и авто-очистка удалены (обязанности закрыты `softLockStaleHours` и
          закрытием документа); обработчик вкладки дебаунсится и не ждёт I/O;
          `setSoftLock` не инкрементит `version` (лок — метаданные присутствия);
          исправлена запись со stale etag через 412-merge, терявшая lock при tie-break.
  - [x] **3.3 — таймерные пути вне движка** — ✅ (2026-07-31, ветка `next`)
    - [x] **B15 — traversal в P2P-приёме закрыт**: `safePosixRelative` + запрет абсолютных
          путей в декодере манифеста, `path.resolve`-проверка в приёмнике. Staging
          входящих с подтверждением и гейт настройкой — закрыты этапом 3.6.
    - [x] **B13 — плановые снапшоты**: напоминание вместо создания/удаления по таймеру;
          возрастная зачистка retention больше не удаляет ручные снапшоты.
    - [x] **B12 — cross-cloud backup**: предложение «Скопировать» вместо самостоятельной
          репликации во второе облако.
    - [x] **B11 — `backgroundCloudAllowed()`** в четырёх точках (probe, presence,
          fetchPresence, регистрация машины при активации): `off` означает тишину,
          429 от опросов не блокирует ручные операции.
    - [x] **`.gitignore`**: дозапись существующего файла — только после «Дописать».
  - [x] **3.5 — панель «Расхождения»** — ✅ (2026-07-31, ветка `next`)
    - [x] `src/core/divergencePlan.ts` — чистое ядро: группировка по воркспейсам всех
          открытых корней, направление и причина строки, фильтры, счётчики, ключ строки,
          отбор для массовых действий. 29 тестов без моков.
    - [x] **Источник данных — `syncStatus`, а не `previewSyncPlan`.** Последний качает
          полное тело каждого отслеживаемого файла (`syncEngine.ts`, без `ifNoneMatch`):
          N полных загрузок на каждое открытие панели. Детектор те же статусы уже
          поддерживает условными GET'ами — панель читает готовое, открытие бесплатно.
    - [x] `src/ui/divergencePanel.ts` — вебвью по §625: группы, чекбоксы (строка/группа),
          чипы фильтра, «Отправить выбранные», «Скачать выбранные», «Сравнить»,
          «Разрешить», «Обновить». Синглтон с самого начала (в отличие от `settingsPanel`,
          находка F8); подписки живут в собственном массиве и освобождаются на dispose.
    - [x] **Закрытый протокол сообщений.** Валидатор `parseDivergenceRequest` вынесен в
          ядро (тестируемо без мока `vscode`); панель не принимает имя команды со
          страницы — ровно та дыра, что есть в `commandCenter` и `settingsPanel`.
    - [x] Действия маршрутизируются в существующие методы движка и команды; массовые —
          с пофайловой изоляцией, прогрессом и отчётом. Конфликты в массовые действия не
          попадают: выбор стороны — отдельное решение, а не галочка среди десяти других.
    - [x] Клик по статус-бару ведёт в панель (§624); уведомление §626 — один
          ненавязчивый тост при первом конфликте за сессию, по изменению
          `vscodesync.json`, а не по таймеру.
    - [x] Гейт `tests/unit/divergencePanelTemplate.test.ts`: CSP с nonce, отсутствие
          внешних ресурсов и `executeCommand` со страницы, экранирование данных,
          совпадение ключа строки с общим разделителем.
    - [x] **Найдено гейтом гигиены:** в ключ строки попал сырой байт NUL, а вебвью
          считал ключ через пробел — чекбоксы не находили бы строки. Разделитель стал
          экспортируемой константой с escape-записью, формула ключа — одна на ядро,
          панель и страницу.
    - [ ] `previewSyncPlan` качает тело каждого файла без `ifNoneMatch` — тот же симптом
          «подвисает», что и B8, только другим путём. Чинить на этапе 5 вместе с
          выделением слоя `io/`, не точечно.
    - [ ] `bulkPullSelected` стал подмножеством панели, но его зовут `goHomePreflight` и
          Smart Digest — снимать в 3.4 вместе с сокращением палитры, не раньше.
  - [x] **3.4 — режим `full` удалён, миграция настроек** — ✅ (2026-08-05, ветка `next`,
        коммиты `d1d5b4f`, `d41a086`, `c4cf8e5`)
    - [x] `autoSyncMode` → `off | check-only`; легаси-`"full"` из старых settings.json
          читается как `check-only` (страховка для машин, не прошедших миграцию).
          Закрыты B7 (стартовый pull), B8 (полный проход по фокусу), B9 (тихие часы),
          B10 (save→push, open→pull, commit→push): триггеры стали детекторами —
          пересчёт статуса воркспейса файла вместо движения данных. Побочно закрыт
          один пункт долга C13 (обход резолвера пути в syncTriggerManager).
    - [x] Семейство расписания удалено: 7 модулей + проводка (статус-бар, health,
          диагностика, мониторы). B3 закрыт полностью. Скелет scheduledJobsDispatcher
          (потребитель — только свой тест) удалён; живые планнеры backupVerify и
          autoPause остаются.
    - [x] `deltaSync`/`deltaThresholdKB` (C24), `conflictRules` (B14), `lineEnding` (C25),
          `saveDebounceSecDefault`, `watchIdleCyclesBeforeBackoff` — удалены из схемы,
          кода, nls, README. Схема: 99 → 91 настройка. Все замыслы — в
          `docs/v2/deferredWiring.md` ДО удаления кода (правило раскопок).
    - [x] `migrateSettingsTo100`: `full` → `check-only` по каждому scope с одноразовым
          уведомлением («Что изменилось» → панель), вычистка 10 удалённых ключей с
          логом в Output, отчёт о непустой оффлайн-очереди без выполнения (§660).
    - [x] `bulkPullSelected` снят; `goHomePreflight` и Smart Digest ведут в панель
          «Расхождения».
    - [x] **Адверсарное ревью 3.4** (65 агентов, 5 линз × 2 скептика на находку):
          27 подтверждённых хвостов исправлены — недочищенные поверхности
          (панель настроек редактировала 2 удалённых ключа; совет установить
          удалённый `lineEnding`; 8 битых id команд в Command Center — часть
          сломана задолго до 3.4; тексты панели/nls/README/walkthrough обещали
          автосинхронизацию), поведенческий дефект (UNAUTHORIZED при детекторном
          пересчёте клал в оффлайн-очередь fullSync, которого никто не заказывал —
          детекторы больше не трогают очередь вовсе), write-only backoff снова
          читается монитором очереди, решающая часть миграции вынесена в чистый
          `settingsMigrationPlan.ts` (8 тестов, включая folder-scope и
          идемпотентность). Осиротевший `utils/editorConfigEndOfLine.ts` удалён.
    - [ ] Остатки после ревью (не 3.4-регрессии, зафиксированы): `perGlobScheduler`
          и rc-ключ `perGlobSchedule` — скелет фазы 22 без потребителей, решение в
          F10 (этап 6.2) вместе с `backupVerifyScheduler`/`autoPauseTickPlanner`;
          гейт `affectsConfiguration` не видит template-литералы — расширить на
          этапе 6; миграция в двух окнах VS Code может показать тост дважды
          (записи идемпотентны, вред — дубль тоста).
    - [x] Остаток 3.3 закрыт этапом 3.4 (B7/B8/B9 умерли вместе с `full`, B14 — с
          `conflictRules`). Осталось: **B16** (GDrive `listFolder` создаёт папки) —
          этап 4.4; снапшоты (ручные и по кнопке) по-прежнему идут мимо
          E2E-шифрования — известная проблема, чинить при выделении `io/`-слоя
          (этап 5).
  - [x] **3.6 — операции, разрушающие данные в один клик** — ✅ (2026-08-06, ветка `next`)
    - [x] **D5 — AI merge.** Ответ модели больше не пишется поверх файла: он уходит в
          превью-файл внутри `localBackupDir/.ai-merge/`, открывается `vscode.diff`
          «локальная ↔ AI merge» с оценкой «+N / −M строк» (чистый
          `core/aiMergePlan.ts`, 6 тестов), применяется только по «Применить» и только
          после бэкапа локальной версии. Пуш — отдельный вопрос, а не следствие мёржа.
    - [x] **D5 — «Keep Mine» больше не хоронит чужой push.** `TrackedFile.conflictCloudHash`
          запоминает облачный хэш в момент отметки конфликта; `resolveConflictKeepMine`
          возвращает `pushed | cloud_moved | not_conflicting` и при ушедшем вперёд облаке
          ничего не пишет. 412 внутри `pushFile` тоже отдаётся как `cloud_moved` — раньше
          метод молча рапортовал успех. Все 5 точек вызова (палитра, панель «Расхождения»,
          batch, пошаговый разбор, AI merge) — через общий
          `ui/conflictKeepMinePrompt.ts` (Всё равно оставить моё / Сравнить).
    - [x] **D6 — «Восстановить файл» точечный.** `pullAll` (force-pull всего воркспейса
          мимо `detectChange`) заменён на `pullFile` удалённого файла.
    - [x] **D7 — Quick Transfer «Получить».** Ядро разделено на
          `prepareQuickTransferReceive` (ничего не пишет, сообщает `destExists`) и
          `applyQuickTransferReceive`; при существующем файле — «Перезаписать (с бэкапом) /
          Сохранить рядом / Отмена»; облачный пакет удаляется только после успешной
          записи. 4 новых теста.
    - [x] **B15-остаток — staging входящих P2P.** Настройка
          `vscodesync.p2p.acceptIncomingFiles` (default `false`) — при выключенной приёмник
          не подключается вовсе. Входящие ложатся в `.vscode/vscodesync-incoming/<transferId>/`
          и ждут «Применить / Сравнить / Отклонить»; применение делает бэкап.
          Чистый `core/p2pStagingPlan.ts` (4 теста) владеет обеими проверками пути.
    - [x] **Общие примитивы:** бинарно-безопасный `writeFileAtomic` (закрывает половину
          D8 — пользовательские файлы пишутся через tmp+rename с retry по EPERM/EACCES/EBUSY);
          `core/localFileBackup.ts` — бэкап/прунинг вынесены из `syncEngine.ts` и
          используются четырьмя путями вместо одного; `ui/localBackupSettings.ts` —
          один читатель трёх `localBackup*`.
- [x] **Этап 4. Провайдеры** — ✅ (2026-08-06, ветка `next`)
  - [x] **4.1 — E1, единый классификатор HTTP-статуса.**
        `providers/_shared/classifyHttpError.ts`: 401 и auth-причины в теле →
        UNAUTHORIZED, троттлинг-причины 403 и 429/503 → RATE_LIMITED с
        Retry-After, переполнение раньше остальных веток, 404/410 → NOT_FOUND,
        409/412/428 → PRECONDITION_FAILED, 5xx → SERVER_ERROR. 32 места в
        четырёх провайдерах переведены на него (было: 46 из 48 бросали
        NETWORK_ERROR, из-за чего отозванный токен выглядел как «нет сети»).
        `forcedRefreshFetch.ts` — один принудительный refresh по 401 и один
        повтор. OneDrive `maybeRefreshToken` перестал возвращать заведомо
        протухший bundle. Гейт `providerErrorClassificationUsage.test.ts`.
  - [x] **4.2 — E14, E4, E2, E3.** `providers/_shared/tokenStore.ts`: одна
        раскладка SecretStorage (три копии модулей и инлайн OneDrive удалены,
        панель настроек снята с шести литералов) + мьютекс `refreshOnce`.
        Мёртвая пятая схема `vscodesync.token.<type>` удалена, замысел
        мультиаккаунта записан в `docs/v2/deferredWiring.md`. Яндекс переведён
        с implicit на authorization code + PKCE: вместе с потоком исчез
        HTML-шим и его обработчик, принимавший токен без проверки
        state/Origin/Content-Type.
  - [x] **4.3 — E5, E8, E9, E12.** `providerFetchOutcome.ts` — разбор исхода
        внутри `withRetry`: троттлинг Google в виде 403 наконец доходит до
        ретрая, переполнение не ретраится и поднимает баннер с самыми тяжёлыми
        файлами (`planQuotaExhaustion` подключён спустя две версии простоя),
        Dropbox получил ретрай-конверт, Яндекс — тоже (423-циклы не ломаются).
        `bumpOfflineFlushBackoff` убран из транспортного слоя, первый успешный
        запрос сбрасывает бэкофф.
  - [x] **4.4 — B16, D12, D11.** У Google Drive разделены `resolveFolderPath`
        (поиск, `null`) и `ensureFolderPath` (создание); `listFolder`,
        `getMetadata`, `downloadFile`, `deleteFile`, `getWebViewLink` больше не
        создают папок — раньше это делал даже probe раз в 30 с. Дубли имён
        разрешаются детерминированно (минимальный id) с предупреждением.
        Удаление у Яндекса и Drive стало обратимым (корзина), безвозвратное
        вынесено в `purgeFilePermanently` контракта.
  - [x] **4.5–4.6 — E6, E7, E10, E13** — ✅ (2026-08-06, ветка `next`)
    - [x] **E6** — чанки upload-сессии OneDrive шли мимо `graphFetch`: 429/503
          падали как NETWORK_ERROR без `Retry-After`, 5xx не классифицировались,
          а любой сбой перезаливал файл с нуля. Теперь каждый чанк — через
          `withRetry` + общий разбор исхода (202 «принято, продолжай» —
          отдельная ветка), перед заливкой читается `nextExpectedRanges`
          (возобновление вместо перезаливки), при ошибке сессия закрывается
          `DELETE`, чтобы не блокировать следующую попытку.
    - [x] **E7** — `planDropboxUpload` был написан и вызывался только из своего
          теста; файлы больше ~150 МБ не заливались никогда. Подключён:
          `upload_session/{start,append_v2,finish}`, 409 при `update`-режиме
          остаётся PRECONDITION_FAILED, как в одношаговом пути.
    - [x] **E10** — в `FileMetadata` появилось поле `contentDigest`
          (`md5 | sha1 | sha256 | dropbox-content-hash`), заполняемое из того,
          что провайдер определяет как хэш: Graph `file.hashes`, Dropbox
          `content_hash`, Drive `md5Checksum`, Яндекс `md5`. Обе проверки
          целостности в движке переведены на него — раньше они сравнивали
          непрозрачный `etag` (`{GUID},N` у OneDrive, `rev` у Dropbox) с хэшем
          содержимого, из-за чего при включённом `providerHashVerify` **каждый**
          push на OneDrive падал с INTEGRITY_FAILED после успешной заливки.
          Заодно у Яндекса убрана догадка «похоже на md5» по регулярке.
    - [x] **E13** — `createFolder` у OneDrive был пустой заглушкой (три других
          провайдера его реализуют): теперь создаёт цепочку папок идемпотентно
          (409 = уже есть). У Dropbox появился `getWebViewLink` — единственный
          провайдер, у которого «Открыть в облаке» ничего не делало. Эмуляции
          `ifMatch` (Яндекс) и `ifNoneMatch` (Dropbox) остались — у этих API нет
          условных операций — но их природа названа в коде явно: проверка, а не
          гарантия; защита от потерянного обновления живёт слоем выше, в
          412-merge `_meta`. PKCE-обёртки OneDrive/Drive
          **подключены** — см. отдельный пункт ниже.
  - [x] **E11** — ✅ (2026-08-06) закрыт **без** прогона против живого API:
        вместо ответа на вопрос «отдаёт ли Drive заголовок ETag на
        PATCH/multipart-POST» убрана сама зависимость от него. Оба upload-пути
        запрашивают `fields=id,md5Checksum` — документированный дайджест
        содержимого, который Drive возвращает всегда, — и берут версию из него;
        заголовок принимается, когда есть, но ничто на нём не держится. Это
        важно, потому что `syncEngine` делает `etag = res.etag ?? etag`:
        отсутствующее значение молча сохраняло **прежний** etag, и следующий
        условный запрос сравнивался с версией, которой уже нет. Мёртвое поле
        `DriveFileSummary.etag` удалено вместе с двумя фолбэками на него — ни
        один `fields=` в провайдере его никогда не запрашивал.
- [ ] **Этап 5. Рефакторинг ядра** — `syncEngine.ts` 4555 строк → оркестратор < 600 строк
      плюс слои `plan/` и `io/`.
  - [x] **5.0 — снапшоты уходили в облако открытым текстом** — ✅ (2026-08-06, ветка `next`)
        `snapshotsEngine` не вызывал `encrypt` ни разу: при включённом
        `vscodesync.encryption` полная читаемая копия воркспейса лежала в облаке,
        причём три из восьми точек вызова — автоматические (pre-merge,
        pre-key-rotation, по расписанию). Введён обязательный параметр
        `SnapshotCrypto` — компилятор перечислил все восемь мест; блобы идут
        через тот же `cloudBlobCodec`, что и файлы; в мету добавлено поле
        `encryption`, поэтому старые незашифрованные снапшоты продолжают
        восстанавливаться, а новые без ключа не восстанавливаются вовсе.
        При включённом шифровании и недоступном ключе снапшот **не создаётся**
        (было бы записью открытым текстом). Снапшот-diff научился расшифровывать
        (иначе показывал бы шифротекст — тот же класс, что C20). 6 тестов.
  - [x] **5.1 — слой `src/core/plan/` (чистые функции), закрыт C17** — ✅ (2026-08-06, ветка `next`)
        `planFileAction.ts` — единственное место, где принимается решение
        push/pull/conflict. Раньше их было **четыре** (`checkOneFileStatus`,
        `syncOneFile`, `previewSyncPlan`, `reconcileBeforePushUpload`), и только
        первое содержало терм `localHash !== cloudHash` в страховке от
        отставания консенсуса — остальные три отвечали «pull» для файла,
        содержимое которого уже совпадает с облачным (правка и откат правки),
        отчего статус плавал между тиками, а «↓1» в панели ничего не тянуло.
        Канонический вариант — строгий. Плюс `syncStatusForAction`.
        `planUploadEncoding.ts` — пара «кодирование + путь блоба» (путь несёт
        `.gz` только когда сжатие реально сработало; расхождение этой пары
        когда-то указывало блобы в никуда), подключён в обе точки заливки.
        `planTrackingDiff.ts` — состав отслеживаемых файлов против манифеста
        (adopt / rename / prune) одной функцией: раньше отчёт о дрейфе и само
        усыновление считали это порознь, и только второе знало о переименованиях.
        Гейты: `planLayerPurity.test.ts` (в `plan/` запрещены `vscode`, ФС, сеть,
        UI и провайдеры) и потолок строк `syncEngine.ts` — 4600, снижать по мере
        5.2–5.3, не повышать. 21 тест матрицей без моков.

- [x] **Этап 6. Поверхность и релиз** — ✅ (2026-08-06, ветка `next`)
  - [x] **F13** — уже был закрыт: `extensionIdentity.ts` — единственный источник
        id расширения, тест пиннит его к `package.json`.
  - [x] **F9** — context-ключи `vscodeSync.activeFileTracked` / `activeFileConflict`
        вычислялись на каждое переключение вкладки и не использовались ни в одном
        `when`. Теперь на них завязано подменю редактора: «Добавить в синхронизацию»
        только для неотслеживаемых, push/pull/сравнение/история — только для
        отслеживаемых, «Оставить моё / Взять их» — только при конфликте.
  - [x] **F8** — панель настроек стала синглтоном (`reveal` вместо второго
        вебвью), подписки живут в локальном массиве и освобождаются в
        `onDidDispose`, а не копятся в `context.subscriptions` до деактивации.
  - [x] **F11** — `scripts/generate-settings-schema.mjs` генерирует
        `src/ui/settingsSchema.generated.ts` из `contributes.configuration`
        (92 настройки, описания — из тех же nls-бандлов, что читает VS Code).
        Панель больше не хранит свой список ключей: она рендерит вручную
        размещённые разделы плюс секцию «Прочие», построенную циклом по схеме,
        поэтому объявленная настройка не может выпасть из панели. Гейт
        `settingsPanelCoverage.test.ts`.
  - [x] **F12 (частично)** — палитра: девять команд входа свёрнуты в
        `VSCodeSync: Войти в облако` с QuickPick, шесть панелей — в
        `VSCodeSync: Открыть панель…`; варианты остались зарегистрированными
        (Command Center, keybindings, `executeCommand`), но скрыты из палитры
        (`when: "false"`): 18 → 32 скрытых записи.
  - [x] **F10** — утверждение плана «~13 незавершённых модулей в бандле»
        **опровергнуто фактом**: esbuild собирает от `src/extension.ts` с
        `bundle: true` и вытрясает неимпортируемое — `grep` по
        `dist/extension.js` не находит ни одного имени. Замыслы всех 11 скелетов
        записаны в `docs/v2/deferredWiring.md`, гейт `bundleSkeletons.test.ts`
        не даёт им незаметно попасть в поставку.
  - [x] **`docs/functional.md`** — каталог возможностей, которого в проекте не
        было: одна запись на возможность, без версий и истории.
  - [x] **PKCE-вход для OneDrive и Google Drive подключён** — ✅ (2026-08-06,
        решение владельца «два варианта лучше одного»). `runOneDrivePkceOAuth` и
        `runGdrivePkceOAuth` были написаны и не вызывались ниоткуда: оба
        провайдера входили только через Device Code, где код надо переносить
        руками. Теперь «Войти в облако» предлагает **браузер первым** (редирект
        возвращается на `127.0.0.1`, вводить нечего) и **код устройства**
        вторым — для SSH, контейнеров и случая, когда браузер не открывается.
        Device Code не удалён: это другой путь, а не худший.
        Опасение «сломается вход у тех, кто регистрировал приложение только под
        device code» проверено и **не подтвердилось**: гайд регистрации в самом
        расширении уже требует вписать в Azure
        `http://127.0.0.1:8736/oauth-callback` — ровно тот URI, что использует
        PKCE-поток; у Google клиент типа `Desktop app` принимает loopback на
        любом порту без регистрации. Остаточный риск (регистрация не по гайду)
        закрыт текстом ошибки: сообщение про `redirect_uri` называет нужный URI
        и предлагает войти кодом устройства. Добавлены команды
        `onedriveSignInBrowser` / `googleDriveSignInBrowser`, обновлены
        Command Center, гайд регистрации и `functional.md`. Гейт
        `signInFlowChoice.test.ts` пиннит порядок способов и совпадение URI в
        коде и в инструкции.
  - [x] **DuckDB / `openAnalyticsPanel` снят с 1.0.0** — ✅ (2026-08-06, решение
        владельца). Панель не имела интерфейса запроса (тост «work in
        progress», `planVirtualTableMount` без вызывающих) и **не работала бы в
        собранном `.vsix` вовсе**: URI `.wasm`/воркера указывали в
        `node_modules/@duckdb/duckdb-wasm/dist`, который исключён
        `.vscodeignore`. Доделка стоит +34–39 МБ к пакету (при остальном бандле
        1.7 МБ) плюс сам UI. Удалены команда, её nls-ключи, пункт в
        `openDashboard`, регистрация в `extension.ts`, сборка моста в
        `esbuild.mjs`, упоминания в README и `functional.md`. Код ядра и
        `registerAnalyticsPanel.ts` оставлены, замысел и цена — в
        `docs/v2/deferredWiring.md`.
  - [x] **F12 (остаток)** — junk drawer `plannedPaletteCommands.ts` (1115 строк,
        27 команд из семи доменов) разрезан на `src/commands/palette/`:
        `pauseAndWatch`, `snapshotCommands`, `encryptionKeyCommands`,
        `workspaceStructureCommands`, `insightsPanelCommands`,
        `syncDiagnosticsCommands`, `workspaceLayoutCommands` плюс `_shared`
        (тип extras и три общих хелпера) и `index` — `extension.ts` по-прежнему
        зовёт одну функцию, но восьмая группа не потребует правки `activate()`.
        Eslint-правило: `vscode.commands.registerCommand` запрещён в
        `src/ui/**` и `src/startup/**`, кроме семи модулей-панелей, владеющих
        своей точкой входа (список в конфиге с обоснованием). Гейт
        `commandRegistrationLayout.test.ts` пиннит: junk drawer удалён, список
        исключений не протух, все 27 команд зарегистрированы ровно по разу,
        ни один доменный модуль не длиннее 320 строк.

---

## Фаза 26 — гигиена пакета и онбординга (после 1.0.0)

- [x] **Из `.vsix` убран инструментарий разработчика** — ✅ (2026-08-11, ветка `next`)
      `.husky/**`, `.lintstagedrc.json` (`9e04e45`), `AGENTS.md` (`8594eec`),
      `media/QR-Code.jpg` и `media/walkthroughs/README.md` (`eafe696`). QR-код README
      подтягивает по ссылке с raw.githubusercontent — локальная копия ехала зря.
- [x] **Битые видеоплееры в «Начало работы» устранены** — ✅ (2026-08-11, ветка `next`,
      `b4ae535`) Три шага walkthrough ссылались на `.md` с `<video src="…mp4">`, сами
      ролики в `.gitignore` и не записаны — уехало в v1.0.0 и v1.0.1. Наличие записи
      стало данными спеки (`VideoSpec.hasRecording`), при `false` шаг отдаёт статичную
      иконку. Регрессию держит гейт `tests/unit/walkthroughMediaIntegrity.test.ts` по
      всем `media`-ссылкам манифеста и `src=` внутри markdown-тел.
      Итог по пакету за фазу: **38 → 13 файлов, 498.22 → 453.08 KB**.
- [x] **Онбординг описан в каталоге возможностей** — ✅ (2026-08-11, ветка `next`)
      Секция «Первый запуск и онбординг» в `docs/functional.md`: мастер первого
      запуска (имя машины → провайдер → способ входа → workspace → телеметрия),
      его повторный вызов командой и walkthrough «Начало работы» как отдельная
      точка входа. Раньше каталог не описывал ни то, ни другое.
- [x] **Видео-заготовки в walkthrough свёрнуты** — ✅ (2026-08-11, ветка `next`)
      `videoAddFirstFile` удалён как полный дубль шага `addFile` (тот же
      `onCommand:vscodesync.addCurrentFile`). Два оставшихся доведены до
      полноценных текстовых шагов `resolveConflict` и `timeTravel` — русское
      описание и кнопка-команда, как у первых пяти: конфликты и Time-Travel
      слайдер иначе исчезли бы из онбординга вовсе. Раскадровки будущих роликов
      сохранены в `src/core/walkthroughVideoSpec.ts`; там же вскрылось, что
      модуль не подключён к рантайму — записано в `docs/knowledge.md`.

## Фаза 27 — Link Bindings: структура не обязана совпадать (после 1.0.0)

> Дизайн: [docs/v2/linkBindings.md](../v2/linkBindings.md). Согласован владельцем
> 2026-08-11 (проработка: 3 конкурирующих дизайна + 3 судьи; победил оверлей).

- [x] **Этап 1 — ядро идентичности и привязки** — ✅ (2026-08-11, ветка `next`)
      Манифест: `linkId` (детерминированный бэкфилл без bump version),
      `linkName`, `bindings` (по-ключевой LWW-merge на `boundAt`),
      `folderBindings` (пер-машинные папочные правила: работа `promed/**` ↔ дом
      `php/**`, действуют и на будущие файлы через adopt/addFiles);
      `schemaVersion` остаётся 1. Локально: `TrackedFile.manifestPath`/`linkId`,
      единый `manifestKeyOf` + свип ~70 точек ключевания движка (меta/манифест/
      blob/history/hash/locks) + гейт `tests/unit/manifestKeyUsage.test.ts`.
      Честный статус `missing_local` по всем поверхностям (декорации — включая
      старый баг «✓ у отсутствующего файла», дерево, панель, статус-бар, SCM,
      дайджесты, explain). Команды `vscodesync.bindLocalFile` /
      `vscodesync.bindLocalFolder` (+nls en/ru, меню). Анти-воскрешение bind в
      tombstone. Локальный rename привязанного файла = rebind без модалки.
      Потолок движка соблюдён выносами: deleteCloudFolder, directChildFolderIds
      + listRemoteWorkspaceSummaries, planBlake3Backfill, planCloudScanRepair,
      planWorkspaceMergeCfg, manifestCacheFields, touchManifestMachine,
      verifyProviderContentDigest (DRY push/pull). Проверки: compile/typecheck/
      lint чисто, 282 файла / 2398 тестов.
- [x] **Этап 2 — размещение при pull и дедуп при добавлении** — ✅ (2026-08-11,
      ветка `next`) Pull-QuickPick «Сюда / Выбрать папку и имя… / Привязать к
      существующему…» в дереве и панели (общий `commands/_placementFlow.ts`),
      батч-вопрос в Pull All, заметка о раскладке после attach,
      `planAddDuplicates` + модалка/canPickMany в добавлении, linkName InputBox,
      hash-подсказки в bind-пикере, row-action «Привязать…» в панели, бейдж
      «⇄ канон» в дереве. Индекс подсказок — напрямую через провайдер
      (`_cloudIndex.ts`), движок не растёт. 283 файла / 2404 теста.
- [x] **Этап 4 — папочный UX: дерево, отправка с обрезкой, приём в свою папку,
      scope** — ✅ (2026-08-11, ветка `main`) По запросу владельца (работа
      `promed/`+`jscore/` ↔ дом `src/SEMD272/…`). A: дерево папок
      (`planFileTree`, схлопывание цепочек, бейдж канона на папке, действия
      «Скачать папку» / «Привязать папку…», настройка
      `tree.groupFilesByFolder`). B: выбор канонического корня при отправке
      папки (`planCanonicalRoot`) + запись папочного правила в
      `addFiles({canonicalRoot})`. C: приём папки при подключении воркспейса
      («Взять как есть» / «Положить в свою папку…», путь может не
      существовать) с предпросмотром `planFolderIntake` — «облако → сюда»,
      совпадение структуры, коллизии не перезаписываются. D: `syncScopes` —
      пер-машинный выбор папок (`syncScope.ts`, фильтр adopt/drift,
      `setWorkspaceSyncScopes`, команда `pickSyncScopes`). Потолок движка
      удержан выносами `folderBindingOps.ts` и слиянием четырёх дублирующих
      сеттеров манифеста в `setManifestField`. 288 файлов / 2442 теста.
- [x] **Этап 3 — rename/rebind-потоки** — ✅ (2026-08-11, ветка `next`)
      Модалка rename для непривязанных (в облаке для всех / только здесь;
      case-only — рекомендация «только здесь»; привязанные ребиндятся молча),
      «Файл переехал — перепривязать…» в промпте удаления, реплей чужого
      rename без молчаливых переносов байтов (тост «Переместить у меня /
      Оставить мою»), самолечение привязок раз за сессию
      (`planBindingSelfHeal`), диагностика дубликата `linkId` + чистый
      `repairDuplicateLinkIds`, `vscodesync.renameLinkName`. Потолок движка
      соблюдён выносом `previewSyncPlan` → `syncPreview.ts`. 284 файла /
      2411 тестов. Metadata-only guard не понадобился (guard уже считает
      только tombstone-ы); запуск ремонта дубликатов из UI — полировка.

## Фаза 28 — Правка канонических путей: редактируемая структура воркспейса

> Дизайн: [docs/v3/canonicalPaths.md](../v3/canonicalPaths.md). Согласован
> владельцем 2026-08-12 (проработка: 6 агентов-разведчиков + 3 конкурирующих
> дизайна + 3 судьи; победил UX-first с батч-инвариантом минимального).

- [x] **Этап 0 — фиксы rename-фундамента** — ✅ (2026-08-12, ветка `next`)
      Найдены разведкой и проверены кодом: спред-баг `removedAt` при rename на
      tombstone-путь; verbatim-перенос `_meta` (хэш расходился при смене
      расширения); удаление блоба ДО putManifest; сиротеющая история; сброс
      Lamport в `rebuildManifestFilesFromTracked` (теперь high-water mark в
      `ActiveWorkspaceEntry`); неподключённый `repairDuplicateLinkIds` (теперь
      едет в каждом 412-merge); rename-осведомлённость massChangeGuard и
      onPurgeLostFiles; конвенция unbind в `untrackFileLocal`; кэш
      `TrackedFile.linkId` при adopt/replay; единый резолвер пути блоба;
      ужесточение regex файловых команд (не светятся на папках).
- [x] **Этап 1 — ядро переезда ключей** — ✅ (2026-08-12, ветка `next`)
      `canonicalRename.ts` (пара tombstone+наследник, единый батч-version,
      материализация linkId, миграция folderBindings с identity-нейтрализацией),
      `planCanonicalRename.ts` (композиция правок, коллизии, предупреждения),
      `io/canonicalRelocation.ts` (блобы→история→манифест→_meta→delete-last,
      идемпотентно), `renameCanonicalKeys` в движке, `renameTrackedFile`
      переведён на общую машинерию.
- [x] **Этап 2 — реплей и сходимость** — ✅ (2026-08-12, ветка `next`)
      Фаза linkId-спаривания в `planTrackingDiff` (цепочки, офлайн >30 дней);
      агрегированный тост на префикс + батч «Переместить у меня» с прогрессом;
      тост о переигранном переезде; property-тесты сходимости (50 сидов,
      вырожденное равенство version/timestamp).
- [x] **Этап 3 — UX** — ✅ (2026-08-12, ветка `next`) Команды «Изменить путь в
      облаке…» / «Переименовать облачную папку…» / массовый редактор путей
      («строка = файл») с единым превью; канон-режим дерева (⇄ на панели);
      DnD внутри воркспейса = канонический переезд; персист и «Возобновить
      перенос»; intake-промпт ДО первого adopt/pull (`beforeInitialAdopt`) —
      засев второй машины идёт по путям воркспейса.
- [x] **Этап 4 — extras** — ✅ (2026-08-12, ветка `next`) «Отменить последнее
      переименование путей» (инверсный батч); опциональный
      `provider.moveFile` + быстрый путь без перекачки (мок реализует,
      реальные провайдеры — follow-up); спека `docs/v3/canonicalPaths.md`,
      каталог возможностей, README.
- [x] **Follow-up фичи фазы 28** — ✅ (2026-08-12, ветка `next`, одобрено
      владельцем) четыре фичи отдельными коммитами:
      кнопка «Починить дубликаты linkId» из Health Check (`manifestHealthOps`,
      ⚠-строки в отчёте, MUTATION_OPS);
      нативный `moveFile` во всех четырёх провайдерах + фикс `wrapWithQueue`,
      глотавшего опциональный метод (быстрый путь был мёртв в проде), история
      тоже переезжает нативно;
      история и Timeline сквозь переименования (`linkKeyChain`, слияние
      `.history/`-каталогов цепочки, `linkId` в событиях activity, фикс
      Time Travel scrubber — листал по локальному пути вместо канонического);
      GC сирот (`planOrphanGc` с возрастными якорями + скан/сбор из Health
      Check строго в корзину провайдера, «освобождено X МБ»).
      Потолок движка удержан выносами: `manifestHealthOps`,
      `io/trackedBlobReader`, `io/orphanGcOps`, prune → `planTrackingDiff`.

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
