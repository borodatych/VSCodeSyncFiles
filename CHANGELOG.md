# Changelog

All notable changes to **VSCodeSyncFiles** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows a custom `major.minor.maintenance` scheme (each part 0–99,
no carry on 9). See `CLAUDE.md` for build versioning rules.

## [Unreleased]

## [0.8.3] — 2026-05-22

**Критический фикс активации. Расширение регистрировало два
`vscode.window.registerUriHandler` подряд в одной активации, ловило
«Protocol handler already registered for extension» и не запускалось
в строгих хостах (например VibeIDE — собственный fork VS Code). Также
URI-shortcut `vscode://borodatych.vscodesyncfiles/connect?...` для
share-link onboarding де-факто не работал на desktop'е с момента
введения второго handler'а.**

### 🐛 Исправления

- **Двойная регистрация UriHandler ломала activate().** VS Code API
  допускает **один** `vscode.window.registerUriHandler` на расширение.
  Второй вызов бросает `Error: Protocol handler already registered for
  extension <id>`. Marketplace-сборка VS Code эту ошибку проглатывала
  тихо, VibeIDE — нет, и вся `activate()` валилась. Симптом в логе
  хоста: `Activating extension 'borodatych.vscodesyncfiles' failed:
  Protocol handler already registered for extension [object Object]`.
- **`/connect` URI-shortcut фактически не работал.** Из-за того что
  inline-handler в `registerOnboardingFlow.ts` стоял в `subscriptions`
  ВТОРЫМ после `registerVscodeSyncUriHandler` в `registerPhase21Boot
  strap.ts`, он не регистрировался — а первый handler неизвестные
  сегменты (`connect` не входил в `workspace|command|invite`) гасил
  warning'ом «ссылка с неизвестным сегментом». Результат: ни один
  `vscode://borodatych.vscodesyncfiles/connect?workspaceId=…&provider=…`
  link не доходил до диалога подключения после онбординга.

### ♻️ Внутреннее

- Все три URI-shape'а (`workspace/...`, `command/...`, `invite/...`,
  `connect?...`) объединены в **один** диспетчер в `src/ui/vscodeSync
  UriHandler.ts`. Сигнатура `registerVscodeSyncUriHandler` теперь
  принимает `globalConfig: GlobalConfigManager` — нужен для
  `/connect`-ветки (проверка `activeProvider` перед вызовом
  `setActiveProvider`).
- В `src/startup/registerOnboardingFlow.ts` удалены 30 строк inline
  `registerUriHandler({...})` — оставлен short comment с пояснением
  причины слияния.
- В `src/startup/registerPhase21Bootstrap.ts:54` вызов
  `registerVscodeSyncUriHandler(context)` →
  `registerVscodeSyncUriHandler(context, deps.globalConfig)`.

## [0.8.2] — 2026-05-22

**Тост-уведомления больше не блокируют рефреш UI. После любой команды
(Push All / Pull All / Sync / Pull / Push / Force Sync / Resolve /
Detach / Rename / Connect / Delete и ещё ~180 других) дерево
Workspaces и file decorations обновляются мгновенно по факту
завершения операции, а не по закрытию toast'а пользователем.**

### 🐛 Исправления

- **Тосты не держат остальной UI.** В `_runWithEngine.ts:86-93` finally
  блок с `workspacesTree.refresh()` + `fileDecorations.refresh()`
  запускался только после возврата из callback'а `fn()`. Большинство
  команд завершались паттерном
  `await vscode.window.showInformationMessage("…готово")` без
  button-аргументов — `await` ждал, пока пользователь закроет тост по
  крестику или пока VS Code сам схлопнет его (15+ секунд). Всё это
  время картина файлов и оттенок здоровья workspace оставались
  устаревшими. Теперь fire-and-forget уведомления вызываются как
  `void vscode.window.showInformationMessage(...)`: тост показывается
  параллельно, callback возвращается мгновенно, refresh запускается
  сразу.

### ♻️ Внутреннее

- **192 точечных замен `await` → `void`** в 49 файлах, найденных через
  TypeScript Compiler API. Меняются только вызовы с **одним**
  аргументом (без button-кнопок или `MessageOptions`). 28 вызовов с
  кнопками (`"Открыть"`, `"Pull сейчас"`, modal-подтверждения и т.п.)
  оставлены с `await` — там ответ пользователя реально нужен. Затронут
  весь набор command bundle'ов: `registerWorkspaceTreeContext`,
  `registerSyncOps`, `registerFileOperations`, `registerConflicts`,
  `registerFileTreeContext`, `registerPhase21Commands`,
  `registerWorkspaceLifecycle`, `registerWorkspaceMgmt`,
  `registerWorkspaceCreate`, `registerActivitySearches`,
  `registerDiagnostics`, `registerHashMigration`,
  `registerHeavyMisc`, `registerOAuthDeviceCode`,
  `registerP2PSession`, `registerPhase21Commands`,
  `registerPrefetchCommand`, `registerSettings`,
  `registerSmartFeaturesEngine`, `registerTemplateMarketplace`,
  `registerEncryptedBundleExport`, `auth/providerAuthFlows` и ещё
  ~25 UI/startup модулей.
- `runDisconnectP2PSession` поменян с `async (): Promise<void>` на
  обычную `function (): void` — внутри больше нет await'ов.

## [0.8.1] — 2026-05-22

**7-уровневая палитра здоровья workspace и честный `lastSync` после
no-op push. Жёлтый кружок теперь не «врёт» — Push All с результатом
«0 push, 0 pull» обновляет timestamp подтверждения, индикатор честно
переключается на свежий зелёный.**

### ✨ Новое

- **7 уровней индикатора здоровья workspace** вместо 3-х.
  `WorkspaceHealthLevel` расширен: `conflict | editing | noData |
  staleDeep | staleOk | recent | fresh`. Зелёный спектр получил **4
  оттенка** по возрасту последней синхронизации:
  - `fresh` (яркий) — `max(lastSync) < 12 ч`
  - `recent` (средний) — `12 ч ≤ max < 48 ч`
  - `staleOk` (тёмный) — `48 ч ≤ max ≤ 14 дн.`
  - `staleDeep` (очень тёмный) — `max > 14 дн.`
  Жёлтый зарезервирован за soft-lock от другой машины (`editing`),
  красный — за конфликтами (`conflict`). Случаи «нет файлов» и «нет
  валидной `lastSync` ни у одного файла» объединены в синий `noData`
  (холодное состояние «нет данных для оценки»).
- **Tinted cloud-иконка в Workspaces tree.** Эмодзи в title (🔴🟡🔵🟢)
  даёт грубый сигнал, оттенок зелёного передаётся через `ThemeColor`
  на самой облачной иконке слева. Все четыре зелёных оттенка плюс
  conflict/editing/noData зарегистрированы в `package.json`
  (`contributes.colors`) — пользователь может переопределить через
  `workbench.colorCustomizations`. Дефолты подобраны для dark/light/
  highContrast/highContrastLight тем.

### 🐛 Исправления

- **Push All «0 push / 0 pull» больше не оставляет workspace жёлтым.**
  В ветке `action === "none"` (хеши локально и в облаке уже совпадают)
  движок ранее обновлял `file.lastSync` **только** если `localHash`
  или `syncStatus` рассинхронизированы. На уже-синкнутом workspace
  это означало, что `max(lastSync)` старел сам по себе и через 24 ч
  workspace загорался жёлтым — даже если пользователь только что
  сделал Push All и услышал «всё ок, 0 передач». Теперь добавлен
  throttle `LAST_SYNC_REFRESH_THROTTLE_MS = 5 мин`: при подтверждении
  идентичности с облаком `lastSync` обновляется, если предыдущее
  значение старше 5 минут. Фоновый watch-tick по-прежнему не пишет
  `vscodesync.json` при каждом проходе (защита от write-storm), а
  Push All / Pull All / Sync «омолаживают» оттенок.

### ♻️ Внутреннее

- `workspaceHealthLocal.ts` остался pure-helper (без импорта `vscode`)
  — отвечает за level + summaryLines + `workspaceHealthColorId`
  (строковый mapping). Создание `vscode.ThemeColor` вынесено в тонкий
  wrapper `workspaceHealthThemeColor.ts`, чтобы pure-модуль
  юнит-тестировался без рантайма расширения.
- `tests/unit/workspaceHealthLocal.test.ts` переписан под 7 уровней:
  14 кейсов, включая boundary-тесты на 12 ч / 48 ч / 14 дн и
  проверки приоритетов (`conflict` бьёт `editing+staleDeep`,
  `editing` бьёт `staleDeep`).

## [0.8.0] — 2026-05-21

**Audit-pass релиз. Pull rollback гонка закрыта; UX-фичи вокруг ручного
Pull (теперь это основной путь после v0.7 `check-only` default).**

### 🐛 Исправления

- **Pull rollback race.** После ручного Pull статусы файлов мгновенно
  возвращались в ✓, но через 30–60 секунд откатывались обратно в
  `cloud_newer` / `pending_push`. Это происходило при работе с одним
  workspace на двух машинах одновременно, когда другая машина держала
  soft lock (`editingBy`) или meta на cloud отставала от blob'ов. Три
  независимых корня в одной баг-цепи:
  - **`iterateTrackedFiles` soft-lock branch** перетирал статус: как
    только manifest сообщал, что другая машина редактирует файл,
    локальный статус принудительно становился `cloud_newer` — даже
    если хеш диска уже совпадал с облаком. Soft lock теперь остаётся
    **UI-индикацией** через `file.editingBy/editingByName`, а реальный
    статус вычисляется через `checkOneFileStatus` (3-way compare).
  - **Окно гонки в `pullFile`.** Порядок инвертирован: сначала
    `pushMetaJson` (cloud meta), потом `persistMutatedCfg` (локально
    `"ok"`). Если cloud meta upload падает — локальный статус **не**
    переходит в `"ok"`, пользователь видит реальную проблему. Полностью
    закрывает окно между «cfg уже OK» и «meta на cloud ещё старая», в
    которое тик watcher'а раньше успевал переписать статус.
  - **`checkOneFileStatus` missing `consensusLagsLocally` rule.** В
    check-only ветке отсутствовало правило «meta уже обновлена другой
    машиной, наш `file.localHash` отстал», которое в full-sync ветке
    (`syncOneFile`) есть давно. Без него детект `detectChange` ошибочно
    возвращал `push` (а не `pull`), и check-only ставил `pending_push`
    вместо `cloud_newer`.
  - **In-memory `inFlightOps: Set<workspaceId:posixRel>`** в
    `SyncEngine`. Pull/Push помечает файл на время операции, check-only
    watcher пропускает его до завершения. Без блокировок UX — чисто
    уведомление tick'у, что файл сейчас «занят».
- **`globalConfigManager.set()`** теперь сразу делает `save()`. Раньше
  обновлял только `this.cache` и полагался на то, что caller потом сам
  вызовет `save()` — хрупкий API. Старый pattern для batched-write
  доступен через явный `setCached()`.
- **Dropbox `ifNoneMatch` игнорировался.** Provider буквально содержал
  `void options?.ifNoneMatch;` и всегда скачивал blob целиком. Теперь
  эмулирует 304 через `get_metadata.rev` сравнение перед загрузкой.
- **`watchModePoller.tick()`** обёрнут в try/catch. Раньше одна сетевая
  ошибка в `runQuietFullSyncAllFolders` пробрасывала исключение из
  `setInterval`-колбэка и могла оставить таймер без рестарта.
- **`workspacesTree.markPendingDelete` / `clearPendingDelete`** теперь
  сами вызывают `invalidateRemoteCache()` + `refresh()`. Раньше удалённый
  workspace мог висеть в дереве 8–10 секунд (TTL remote-summaries cache).
- **`fileDecorations.provideFileDecoration`** honours `CancellationToken`
  после каждого `await`. Раньше медленная async-цепочка (cfg load → hash)
  могла резолвнуться **после** свежего вызова и перетереть актуальное
  состояние устаревшим.
- **`deleteRemoteBlobBestEffort`** теперь логирует не-`NOT_FOUND` ошибки
  через `warnLog`. Раньше глоталось молча — сетевые сбои при удалении
  старого blob'а оставляли дубли в `.history/` без диагностики.
- **`statusBar.formatLastSync`** — явный 24-часовой `HH:MM` через
  `getHours()` / `getMinutes()` вместо `toLocaleTimeString()`. Последняя
  на некоторых ru-локалях выдавала AM/PM формат.
- **`metaMerge.pickNewer` / `manifestMerger.maxVersion`** — `warnLog`
  при tie-break (одинаковые `version` + `updatedAt` / `addedAt`, но
  разные `hash` / `editingBy`). Раньше молча выигрывал `a`; теперь
  support bundle ловит расхождение.
- **NLS — 14 команд** имели hard-coded английский title прямо в
  `package.json` (`"title": "VSCodeSync: Open Analytics Panel"`) вместо
  NLS-ключа. Русский перевод существовал в `package.nls.ru.json`, но не
  применялся. Команды: P2P session start/disconnect, Passkey settings/
  enroll/unlock/remove/fallback, Analytics panel, Templates marketplace,
  SARIF export, encrypted bundle, prefetch workspace, device-code sign-in,
  workspace README.
- **Provider hash verify** расширен на `pullFile` — после скачивания
  blob'а сравниваем provider etag с локально вычисленным digest. Mismatch
  → `INTEGRITY_FAILED`. Раньше проверка работала только на push.

### ✨ Новое

- **Smart Pull Digest** — `VSCodeSync: Smart Digest — что изменили
  коллеги`. Группирует файлы со статусом `cloud_newer` по машине
  (`editingByName`) или workspace, считает конфликты, рендерит markdown
  с кнопками «Bulk Pull...» / «Подробнее» (открывает digest в virtual
  document для прокрутки).
- **Bulk Pull selectively** — `VSCodeSync: Получить выбранное`. Quick
  Pick с canPickMany по всем файлам `cloud_newer` через все открытые
  workspace'ы. Pre-checked all, прогресс-нотификация, output channel с
  per-file результатами. Закрывает кейс «коллеги обновили N файлов,
  скачать пачкой» — раньше нужно было кликать каждый файл отдельно.
- **«Соберись и иди» pre-flight** — `VSCodeSync: «Соберись и иди» —
  проверка перед закрытием`. Pure planner (`clean | pending_push |
  cloud_newer | conflict | mixed`) → notification c кнопками действий
  (Push all / Bulk Pull... / Открыть Workspaces). Удобно перед
  выключением ноутбука.
- **Compare with cloud** — `VSCodeSync: Сравнить с облачной версией`.
  Скачивает облачный blob в virtual document, открывает `vscode.diff`
  против локального файла. Read-only — никаких записей.
- **Adaptive auto-mode (quiet hours)** — новые настройки
  `vscodesync.quietHours.start` / `quietHours.end` (HH:MM, поддержка
  wrap через полночь, например `22:00→08:00`). Внутри окна `check-only`
  автоматически апгрейдится до `full` (никто не работает — фоновая
  синхронизация безопасна). `off` и `full` остаются нетронуты.
- **Webhook digest** — `VSCodeSync: Отправить дайджест в вебхук
  (Discord / Slack / Telegram)`. Setting `vscodesync.webhookDigestUrl`,
  формат auto-detect по host (Discord webhooks, hooks.slack.com,
  api.telegram.org). Re-uses pure `digestWebhookFormatter` +
  `buildWeeklyDigest`. Recurring schedule — отложен на следующую фазу.
- **Dedicated mini status-bar item** для autoSyncMode (отдельно от
  основного). Иконки `$(eye-closed)` / `$(eye)` / `$(sync)` в зависимости
  от режима. Клик — Quick Pick смены режима (вызывает существующий
  `vscodesync.cycleAutoSyncMode`). Auto-refresh при смене настройки.

### 🚀 Производительность

- **`_shared/fetchWithTimeout.ts`** — общий wrapper над `fetch` с
  `AbortController` (30s API / 120s data) + tracing на канал провайдера.
  Подключён в `gdriveProvider.driveFetch + refreshAccessToken`,
  `onedriveProvider.graphFetch + token refresh + upload session chunks`,
  `dropboxProvider.apiFetch + token refresh`. Раньше эти три провайдера
  использовали голый `fetch` — зависший сетевой запрос мог блокировать
  цикл синхронизации навсегда.
- **Dropbox bandwidth saving.** `ifNoneMatch` эмуляция через
  `get_metadata.rev` — unchanged файлы теперь не качаются целиком
  (см. также в «Исправления»).

### 🔒 Безопасность

- **Provider hash verify на pull-пути** — сравнение provider digest с
  локально вычисленным после download'а blob'а. Mismatch → throw
  `INTEGRITY_FAILED`. Skip для encrypted (provider видит ciphertext) и
  wireGzip (provider digests .gz, не plaintext).

### ♻️ Внутреннее

- **`src/ui/i18nMessages.ts`** — централизованный словарь UI-строк
  (sync labels, auto-mode labels, action labels, common, tooltip
  builder). Цель — устранить en/ru drift, когда один tooltip говорит
  «Last sync», а соседний «Последняя синхронизация» о том же. Компоненты
  мигрируют постепенно (skeleton-acceptable).
- **9 новых pure planners в `src/core/`** (Phase 24 skeletons,
  wiring — следующая фаза):
  - `remotePresencePlanner.ts` — F2 Cursor-style presence chips.
  - `syncRewindPlanner.ts` — F6 точка восстановления по timestamp.
  - `undoableActionRegistry.ts` — U3 in-memory ring для undo
    destructive ops (TTL по умолчанию 60s).
  - `contentDefinedChunking.ts` — M1 Buzhash rolling-hash boundary
    finder (64-byte window, 16K min, 64K max, ~8K avg chunk).
  - `passkeyOnlyMode.ts` — M4 решение allow/deny для passphrase
    fallback с anti-lockout логикой.
  - `githubReleasesProviderPlanner.ts` — M5 tag-naming convention для
    GH Releases as snapshot provider.
  - `s3ProviderPlanner.ts` — M2 bucket-name validation + key prefix
    handling для будущего S3 provider.
  - `trustedTeammatesInvitePlanner.ts` — X2 encode/decode/sign
    invite-link для добавления доверенной машины.
  - `goHomePreflightPlanner.ts` + `smartPullDigestPlanner.ts` —
    pure backends к новым командам F1/F8 (см. «Новое»).
- **Sentinel error classes** на каждом skeleton (`*NotReadyError`,
  `*NotImplementedError`, `*NotConnectedError`) — UI ловит по имени и
  роутит в «work in progress» состояние вместо тихой деградации.
- **`autoSyncModeAdaptive.ts`** — pure helper `parseHmToMinutes` /
  `isInsideQuietHours` / `effectiveAutoSyncMode`. Поддержка wrap через
  полночь. Wired в `watchModePoller`.
- **Test fixtures** — везде заменены реальные имена машин/workspace'ов
  (`PROMED`, `059-1-ws-346`) на абстрактные (`alpha-workspace`,
  `work-laptop`). Договорённость: unit-тесты никогда не используют
  «личные» названия, даже как innocuous fixtures.
- **+52 unit-тестов** (всего 2125). Lint = 0, compile OK.

### 📦 Сборка

- 15 atomic commits (по одному пункту roadmap). Marker
  `~/.claude/roadmap-max-active` снят после завершения автопрохода.
- Phase 24 в `docs/v1/roadmap.md` — 18 закрыто, 9 skeleton-acceptable,
  1 blocked (X3 WebRTC P2P signaling — требует real signaling server,
  перенесён в v2.5).

## [0.7.0] — 2026-05-21

**Крупный релиз. Содержит breaking change в поведении автосинхронизации.**

### ⚠ Breaking

- **`vscodesync.autoSyncMode` по умолчанию = `check-only`.** Раньше любое
  сохранение файла (`onSave`), открытие (`onOpen`) и фокус окна (`onFocus`)
  автоматически дёргали push/pull. Это создавало «гонку» при работе с одним
  workspace на нескольких машинах одновременно: дома сохранил → на работе
  откатилось → дома снова правишь → бесконечный цикл. Новый дефолт
  `check-only` оставляет автоматику только для **обновления статусов**
  (`pending_push` / `cloud_newer` / `conflict` подсвечиваются в дереве),
  но **push и pull выполняются только вручную**. Восстановить старое
  поведение: `vscodesync.autoSyncMode = full` или команда
  `VSCodeSync: Auto-sync mode → full`.

### ✨ Новое

- **`autoSyncMode`** — три режима: `off` (без автоматики), `check-only`
  (только подсветка статусов, default), `full` (историческое поведение).
- **Параллельная синхронизация** — `sync.concurrency` (default 4) для файлов
  внутри workspace и `sync.workspaceConcurrency` (default 2) для workspace'ов.
  Раньше один файл за раз — на больших workspace'ах ускорение до 4×.
- **Adaptive concurrency** — параллелизм автоматически снижается при
  низком заряде батареи, высокой загрузке RAM, или 429/503 от провайдера.
- **Connectivity probe + status bar widget** — иконка online/degraded/offline
  на статус-баре. При offline auto-sync тихо приостанавливается (без
  заваливания Activity Feed ошибками).
- **Sync profiler** — `VSCodeSync: Профиль синка` показывает топ-15
  самых медленных файлов с разбивкой hash/network/verify ms. Opt-in через
  `vscodesync.diagnostics.profileSync`.
- **`vscodesync://` URI scheme** — deep-links для workspace / file / command.
  Команда `VSCodeSync: Копировать share-ссылку` копирует ссылку в clipboard.
- **Invite-ссылки** — `VSCodeSync: Сгенерировать invite-ссылку для коллеги`
  (TTL 24h/7d/30d/без срока) + `VSCodeSync: Подключиться по invite-ссылке`.
- **Conflict — keep both** — третий путь разрешения помимо keep-mine /
  take-theirs: облачная версия сохраняется как `<name>.conflict-<machine>-<ts>`
  рядом, локальная остаётся как pending push.
- **Repair cloud manifest** — `VSCodeSync: Восстановить облачный манифест...`
  пересобирает повреждённый манифест из scan blob'ов + `_meta.json`.
- **`VSCodeSync: Почему файл не синкается?`** — диагностическая команда
  с 10-чек-листом (trust, mode, pause, schedule, rate-limit, workspace state,
  tracking, status, soft lock, last sync).
- **Support bundle export** — `VSCodeSync: Экспорт support bundle (для
  отчёта о баге)` создаёт папку с redacted settings + metadata. Все токены /
  emails / UUID вырезаются.
- **SBOM report** — `VSCodeSync: Экспорт списка синкаемых файлов (SBOM)`
  показывает в Markdown какие файлы и куда синкаются.
- **Trusted teammates** — `VSCodeSync: Добавить доверенную машину...`
  пропускает `requireMachineApproval` гейт для своей машины. Удобно
  командам, где не хочется approval modal на каждую новую workstation.
- **`.vscodesyncrc.json`** — per-workspace overrides allowlisted настроек
  (autoSyncMode, sync.concurrency, lineEnding, …). Файл коммитится в Git,
  применяется автоматически.
- **Контекстуальные подсказки** — однократно в 6 часов, при возврате
  фокуса в окно: «5+ конфликтов? Resolve All», «Облако переполнено?
  Открыть SBOM», и т.п. Opt-out: `vscodesync.hints.enabled = false`.
- **AI Explain Conflict** — `VSCodeSync: AI · объяснить конфликт` копирует
  готовый prompt в clipboard для вставки в Copilot Chat / ChatGPT (с
  3-секционным system prompt: LOCAL intent / REMOTE intent / recommendation).
- **`.gitignore` watcher** — авто-проверяет, что наша блок-разметка не
  пропала после rebase / reset; предлагает re-prompt с 5-min dedup.

### 🚀 Производительность

- **Google Drive folder-id cache** — раньше каждый push на файл
  `src/core/foo.ts` делал 5-7 GET перед PUT (разрешение пути через
  `files.list?q=name=…`). Теперь — один прогрев и кэш на 10 минут (настройка
  `gdrive.folderCacheTtlSec`). На больших workspace'ах ускорение от 3× до 10×.
- **listFolder pagination** — Google Drive (`nextPageToken`), OneDrive
  (`@odata.nextLink`), Yandex (`offset`). Workspace'ы с > 1000 файлов
  больше не теряют файлы при list.
- **Batched cfg writes** — внутри `syncWorkspace` N файловых операций
  больше не делают N записей в `vscodesync.json` — один flush в конце.
- **Lazy history snapshots** — `historyMode = lazy` копит снимки в очереди
  и отгружает пакетом раз в N минут (по умолчанию `inline` — старое
  поведение).
- **withRetry** — единая retry-обвязка для Google Drive `driveFetch` и
  OneDrive `graphFetch`: 5xx (SERVER_ERROR) → exponential backoff с jitter,
  429 → уважает Retry-After header.
- **Provider registry memoisation** — `getFor()` теперь кэширует instance
  per-type, не пересоздаёт класс на каждый вызов.

### 🔒 Безопасность

- **Workspace Trust gates** на 4 destructive commands (repair manifest,
  keep-both, ai-explain, URI openFile). Untrusted workspace не может
  спровоцировать запись на cloud / disk через эти пути.
- **`vscodesync://` URI whitelist** — команды через URI ограничены
  read-only списком (открыть Activity Feed, профайлер, support bundle).
  Destructive (delete, repair) **не** доступны через URI.
- **Provider hash verify** (opt-in, `vscodesync.providerHashVerify`) —
  после upload сравнивается дайджест провайдера (md5 у GDrive/Yandex,
  content_hash у Dropbox, sha256 у OneDrive) с локально вычисленным.
  Mismatch → `INTEGRITY_FAILED` (retry-able).

### 🐛 Исправления

- **Encrypted local backup** — теперь `throws` при `.enc` файле без
  ключа вместо silent возврата ciphertext-as-plaintext (был footgun).
- **`consumeTookOwnershipMarker`** — corrupt JSON marker больше не висит
  вечно, разблокируя toast на каждом poll-tick.
- **`insightsWeeklyDigest.byKind`** инициализирует все 21 ActivityKind
  (было 7 — остальные превращали счётчик в NaN).
- **`syncEngine.repairByCloudScan`** теперь пишет `machineId` вместо
  несуществующего `updatedBy` (out-of-schema поле в `_meta.json`).
- **`p2pSessionRegistry`** — убран dead `case "ended"`, добавлен корректный
  ranking для `disconnected`.
- **`passkeyCommands.orderForDisplay`** — primary passkey теперь поднимается
  наверх QuickPick (была swapped signature).
- **Take-ownership notification** — проигравшее окно VSCode получает
  однократный toast при следующем focus вместо silent flip в Read-only.
- **Default 90-day window** в `conflictHeatmapTimeline` (раньше принимал
  события с 1970-го).
- **Windows-drive guard** в `zipImportPlanner` — `C:/Windows/system32/evil.exe`
  больше не проходит как «безопасный относительный путь».
- **`vscodesync://` URI handler** — `openFile` теперь требует Workspace
  Trust, host segment валидируется до synthesise (precise error code
  вместо generic `scheme_mismatch`).

### ♻️ Внутреннее

- **190+ новых pure-helpers** в `src/core/` (parallelLimit, gdriveFolderIdCache,
  withRetry, planQuotaExhaustion, explainFileSyncState, redactSettings,
  parseVscodeSyncUri, planContextualHints, encodeQrSdpEnvelope,
  providerHashVerify, gitignoreCoexistence, detectWorkspaceContext,
  buildQuickSwitchItems, notebookConflictPlanner, planDropboxUpload,
  buildSbomReport, buildCrossMachineDiff, formatDigestForWebhook,
  trustedMachinesRegistry, perGlobScheduler, encryptedLocalBackup,
  syncExcludeStore, buildReleaseNotes, buildConflictHeatmapTimeline,
  planZipImport, scmResourceGrouper, SyncProgressEstimator,
  buildWelcomeMessage, vscodeTaskDefinitions, connectivityProbe,
  schemaMigrationCoordinator, workspaceInviteLink, adaptiveConcurrency,
  vscodesyncRc, lazyProviderLoader). Все unit-тестированы.
- **+2000 новых unit-тестов** (всего ~2070).
- **TS lib drift fixes** — `Uint8Array<ArrayBufferLike>` vs `BufferSource`
  в `platformCrypto` / `platformCompression`; `Buffer` vs `BodyInit` в
  fetch body для gdrive/onedrive providers.
- **Auto-sync mode wiring** — gate во всех 6 точках авто-триггеров (save,
  open, focus, watch poll, push-on-commit, startup pull).
- **Engine factory** обогащён 11 новыми resolver hooks (читают setting
  live, без rebuild engine при изменении конфигурации).
- **17 новых настроек** в `contributes.configuration` с RU/EN nls.

### 📦 Сборка

- 24 фазы roadmap (`docs/v1/roadmap.md`) — все `[x]` либо `[~]` (deferred
  с явным обоснованием).

## [0.6.3] — 2026-05-13

### Fixed
- **Git API binding (regression of 0.6.2 fix)** — в 0.6.2 `bindRepo` ошибочно
  переехал с `Repository.onDidChangeState` на `Repository.onDidChange`, но и
  такого свойства у `Repository` нет — `onDidChange` живёт только на
  `RepositoryState` (`extensions/git/src/api/git.d.ts`). На каждом активном
  репозитории это давало `TypeError: repo.onDidChange is not a function`,
  каскадно роняя extension host VibeIDE сразу после открытия workspace.
  Затронуты две точки: `src/ui/syncTriggerManager.ts` (push-on-commit) и
  `src/ui/gitBranchWorkspaceActivation.ts` (branch policy). Обе подписки
  перенесены на `repo.state.onDidChange`. Интерфейсы `GitRepoLike` /
  `GitRepositoryLike` приведены в соответствие c реальным API.

## [0.6.2] — 2026-05-13

### Fixed
- **Configuration schema collision** — boolean флаг `vscodesync.aiMerge` переименован
  в `vscodesync.aiMerge.enabled`. Старая схема одновременно держала `aiMerge`
  (boolean) и `aiMerge.endpoint` / `aiMerge.endpointModel` (string-дети), что
  на каждый старт давало по 4 красные строки `Ignoring vscodesync.aiMerge.endpoint
  as vscodesync.aiMerge is false` в Output → Log. Миграция запускается один раз
  при activate (`migrateAiMergeFlag.ts`), переносит значение пользователя
  пер-scope (Global / Workspace / WorkspaceFolder) и чистит старый ключ.
- **Git API binding** — `bindRepo` в `syncTriggerManager.ts` подписывался на
  несуществующий `Repository.onDidChangeState`; на каждом активном репозитории
  это давало `TypeError: repo.onDidChangeState is not a function` при открытии
  и каскадно ронял extension host VS Code/VibeIDE. Заменено на штатный
  `Repository.onDidChange` (см. extensions/git API).

## [0.6.1] — 2026-05-10

i18n / docs релиз — без функциональных изменений.

### Changed
- **Русская локализация v0.6 команд** — `package.nls.ru.json` дополнен 13 заголовками: `Открыть панель аналитики`, `Начать P2P-сессию` / `Завершить P2P-сессию`, `Войти через OAuth Device Code`, `Зарегистрировать passkey` / `Разлок ключа через passkey` / `Удалить passkey` / `Резервный разлок (passphrase)` / `Настройки passkey`, `Установить шаблон workspace (из реестра)…`, `Экспортировать конфликты в SARIF`, `Экспортировать зашифрованный бандл (.vscsbundle)`, `Прогреть кэш активного воркспейса`. Раньше у русскоязычных пользователей в Command Palette эти команды отображались на английском.
- **README** — добавлены v0.6 фичи (P2P, Passkey, Analytics panel, Templates marketplace, OAuth Device Code), компактная секция `Что нового в v0.6`, расширены таблицы команд и настроек, обновлён раздел Конфиденциальность (WebAuthn KEK, AI privacy gate, локальный LLM).

## [0.6.0] — 2026-05-10

Большая функциональная волна за проходы `/roadmap-max` 26-34: 75 коммитов.
Закрыты все actionable пункты v2 roadmap (включая webhook lifecycle adapter,
extension.ts <500 LoC, DuckDB analytics panel с реальной WASM runtime).
Оставшиеся `[~]` пункты — environment / human-blocked (auto-unblock путь
зафиксирован в `docs/v2/breakdown.md`).

### Added (v2.20.2 DuckDB analytics — runtime closure)
- **DuckDB-WASM analytics panel** (v2.20.2) — `vscodesync.openAnalyticsPanel` открывает webview, bootstrap'ит `dist/media/duckdb-bridge.js` (426 KB self-contained ESM с inlined `@duckdb/duckdb-wasm` + `apache-arrow`). Bridge инстанциирует `AsyncDuckDB(ConsoleLogger, Worker(blob+importScripts(workerUrl)))`, выполняет `register_file` / `exec_sql` контракт. `createWebviewWorkerAdapter(panel.webview, dispose)` оборачивает webview под `DuckDbWorkerLike` для existing `createDuckDbHost`. `localResourceRoots` включает `dist/media/` + `node_modules/@duckdb/duckdb-wasm/dist/`; CSP `worker-src ${cspSource} blob:`.
- **DuckDB webview bootstrap planner** (v2.20.2) — `src/core/duckdbWebviewBootstrap.ts:buildDuckDbBootstrapHtml` + `selectDuckDbVariant` (mvp/eh/coi capability fallback) + `DuckDbBootstrapNoBundlesError` sentinel; 8 unit-тестов.

### Added (Cross-cutting features)
- **P2P file-transfer receiver** (v2.12.4) — `attachFileReceiver` подписывается на manifest+file_chunk frames на сессионном channel, собирает файл через `createChunkAssembler`, проверяет hash и пишет атомарно через tmp-rename. Conflict-vs-cloud-pull: P2P deliveries advisory, manifest authoritative.
- **OAuth Device Code flow UI** (v2.20.3) — `vscodesync.signInDeviceCode` walks user через POST device-auth → user-code modal → polling token endpoint via `planDeviceCodePoll`. OneDrive provider entry готов; GDrive — отдельная итерация.
- **Local LLM endpoint в aiMerge** (v2.20.3) — `runAiMerge` теперь dispatch'ит через `resolveAiMergeEndpoint`: `vscode-lm` / `ollama` / `lm-studio` / custom URL. Новая setting `vscodesync.aiMerge.endpointModel`.
- **Workspace templates marketplace** (v2.20.5) — `vscodesync.installWorkspaceTemplateFromMarketplace` fetch'ит registry index, валидирует manifests через `parseWorkspaceTemplate`, применяет: `.vscodesync-template.json` provenance + merge ignorePatterns + welcome webview + extension recommendations.
- **MCP server stub** (v2.20.1) — `@modelcontextprotocol/sdk` installed; `mcpServerHost.startMcpServer` lazy-loads SDK, регистрирует `vscodesync.list_workspaces` tool с реальным data source.
- **DuckDB-WASM lazy-load** (v2.20.2) — `@duckdb/duckdb-wasm@1.33` installed; `duckdbAnalyticsHost.runReadOnlyQuery` валидирует SQL и возвращает `tables_not_mounted` sentinel пока virtual-table mount не landед.

### Changed
- **CLI vscodesync** (v2.20.1) — re-confirmed: `cli/` subpackage уже имеет bin entry `./dist/cli.cjs` с dispatch table (`status` / `pull` / `auth --device-code`); breakdown updated.

### Added
- **DEK rewrap через WebAuthn KEK** (v2.2.x) — `enrollPasskey` оборачивает primary DEK в `KeyEnvelope` с источником `webauthn` (HKDF over PRF output), `unlockWithPasskey` восстанавливает DEK через replay PRF salt из `meta.prfSaltHex`. Helpers `readWebauthnEnvelope` / `storeWebauthnEnvelope` в `core/encryptionKey.ts`.
- **P2P file-transfer mirror** (v2.12.4) — `engine.onPushFile` callback теперь fan-out'ит manifest + file_chunk frames через каждую authenticated session, зарегистрированную в `MirrorRegistry`. Best-effort: ошибки encoding / send swallowed (cloud upload уже authoritative).
- **P2P idle tick + activity log** (v2.12.3 / v2.12.5) — runtime создаёт `createP2PIdleTracker` + 30s setInterval; idle threshold (5 min default) тригерит graceful disconnect. State machine events публикуются как `kind: "p2p_session"` в activity.json через `logSyncActivity`.
- **Adaptive webhook renewal** (v2.10.2) — `oneDriveWebhookLifecycle` мигрирован с fixed `setInterval(4 min)` на `createWebhookRenewalLoop`. Renewal scheduling теперь привязан к expiration time (через `planWebhookRenewal`).
- **WebAuthn enroll / unlock real implementation** (v2.2.1 / v2.2.2 / v2.2.3) — `src/ui/webauthnWebview.ts` opens a one-shot webview that runs `navigator.credentials.create({publicKey})` / `.get()` with the PRF extension. Both vscode.dev (browser) and the desktop client (Electron Chromium → OS FIDO2: Windows Hello / Touch ID / hardware keys) supported. New commands `vscodesync.enrollPasskey` and `vscodesync.unlockWithPasskey`. `core/keyEnvelope.deriveWebauthnKek` replaced sentinel with real HKDF-SHA256 over the PRF.eval.first output (32-byte input, salt-bound).
- **P2P live signaling + DataChannel runtime** (v2.1.3 / v2.12.4) — `src/ui/p2pSessionRuntime.ts:openP2PSession` glues `@roamhq/wrtc` peer connection, cloud signaling transport, state machine and crypto envelope. Both inviter and invitee flows complete via createOffer/Answer + ICE drain + wrapAuthenticated. `vscodesync.startP2PSession` (when `vscodesync.p2p.experimental: true`) prompts for sessionId + peer machineId, generates ephemeral 32-byte AES key, and opens an authenticated DataChannel.
- **P2P loopback smoke test + CI workflow** (v2.1.6) — `tests/unit/p2pSessionRuntime.smoke.test.ts` (opt-in via `P2P_SMOKE=1`) runs full inviter+invitee handshake against a fake transport. `.github/workflows/p2p-smoke.yml` wires both a non-blocking hosted job and an optional self-hosted `p2p-smoke` runner.
- **BLAKE3 migration backfill command** (v2.3.4) — `vscodesync.completeBlake3Migration` reads `_meta.json` of every active workspace, recomputes canonical BLAKE3 over local files, and writes them back via the new public `engine.applyHashBlake3Backfill(workspaceId, tasks)` method. Drift guard refuses to backfill files whose local SHA-256 differs from the meta SHA-256.
- **BLAKE3 migration check command** (v2.3.4) — `vscodesync.checkBlake3Migration` walks every active workspace's `_meta.json` and surfaces per-workspace BLAKE3 coverage + recommended action (`stay_sha256` / `stay_dual` / `recommend_switch` / `safe_to_switch_now`) via existing pure helpers. Dual-workflow start timestamp persisted in `globalState`. Backfill command (`completeBlake3Migration`) left as follow-up.
- **Smart Conflict Prediction — live presence reader** (v2.9.3) — `SmartConflictPredictionService` polls `_machines.json` every 60 s when an authenticated provider is available; peers' `currentEditing` frames cached for 60 s and augment the existing soft-lock score via `findHighRiskPeer`. Status-bar tooltip differentiates risk source (soft-lock / live presence / both).
- **P2P file-transfer engine hook** (v2.1.4) — `SyncEngineDeps.onPushFile?` callback fires after successful `pushMetaJson`. P2P UI runtime can mirror plaintext to peers via WebRTC DataChannel without re-canonicalising. Errors swallowed (best-effort).

### Changed
- **Smart features split** (v2.6.6 / v2.14.1) — extracted 5 engine-rich commands (`aiSessionSummary`, `aiSuggestWorkspaceTags`, `aiPathMapper`, `showInsightsWeeklyDigest`, `diffSnapshots`) from `plannedPaletteCommands.ts` into a focused `src/commands/registerSmartFeaturesEngine.ts` bundle with `{ context, globalConfig, tryAuthenticatedProvider }` contract.

### Added
- **Smart Conflict Prediction — currentEditing presence wire** (v2.9.2) — `presenceHeartbeat` теперь публикует поле `currentEditing` в `_machines.json` для self-entry: каждый tick резолвит `vscode.window.activeTextEditor` через `WorkspaceConfigManager` и пишет `{ workspaceId, relPath, sinceMs }` (или `null` при idle) с throttle 30 s через `shouldBroadcastCurrentEditing`. Mode (`full`/`anonymised`/`off`) читается из существующего setting `vscodesync.smartConflictPrediction.broadcastCurrentEditing`. `parseMachinesRegistry` / `upsertMachineAndPrune` / `syncMachinesRegistrySelf` расширены опциональным параметром (forward-compat).
- **AI privacy gate** (v2.14.2) — 3 новых setting'а `vscodesync.ai.{sessionSummary,suggestWorkspaceTags,pathMapper}.enabled` (default `false`). Команды `aiSessionSummary`, `aiSuggestWorkspaceTags`, `aiPathMapper` показывают opt-in toast с кнопкой `Open Settings` перед первой отправкой данных в LM. Описания указывают что покидает машину (paths only, never contents). `aiMerge` уже имел свой setting `vscodesync.aiMerge: boolean`.
- **AI cancellation** (v2.14.2) — все 3 AI-команды используют `withProgress({ cancellable: true })`; token прокинут в `summariseActivity` / `suggestWorkspaceTags` / `runAiPathMapper` для прерывания LM-запроса.
- **BLAKE3 dual-hash writer** (v2.3.2) — `pushFile` пишет `MetaEntry.hashBlake3` рядом с `hash` (sha256) когда setting `vscodesync.canonicalHashAlgo` = `"blake3"` или `"dual"`. Канонический pipeline (binary detect / BOM strip / line-ending normalise / strip syncignore) единый для обоих алгоритмов через extracted `canonicaliseToHashableBytes`.

### Changed
- **LoC guard tightened** (v2.6.7 / v2.11.4) — `tests/unit/extensionTsLoc.test.ts:LOC_CEILING` понижен с 850 до 820 после удаления tunnel imports.

### Internal
- **Tunnel-backend'ы cloudflared / tailscale-funnel удалены** — позиционирование «indie tool»; `smee.io` признан достаточным. Удалено 13 production-модулей + 9 unit-тестов (~2620 LoC). `oneDriveWebhookLifecycle.ts` откачен на прямой `createAndStartSmeeRelay`. Setting `vscodesync.webhooks.tunnelProvider` и команда `vscodesync.showTunnelStatus` убраны из `package.json`. v2.4 / v2.13 в roadmap помечены как DROPPED.

### Internal (run 32-34 — architectural closure)
- **Webhook lifecycle planner adapter** (v2.10.1) — оба `oneDriveWebhookLifecycle.ts:reconcileBody` + `googleDriveWebhookLifecycle.ts:reconcileBody` переписаны на `planWebhookLifecycleReconcile`. Wrapper становится thin imperative shell поверх ordered action list (`delete_stale_subscription` / `clear_local_state` / `start_local_server` / `create_subscription` / `keep_subscription` / `register_webhook_push` / `start_renew_loop`). GDrive получил pre-pass для expiration validation (planner has no TTL notion).
- **`extension.ts` decomposition fully shipped** (v2.6.7) — 5085 → 494 LoC (-90%), soft target 500 reached. CI guard `LOC_CEILING=495`. Run 32-33 extracted: `createRunAfterSessionResume.ts` / `registerScheduledSnapshotsWiring.ts` / `createEngineLogRefs.ts` / `registerObservers.ts` / `registerProviderAuthBundle.ts` / `registerSyncMonitors.ts` (5 monitors).
- **`media/duckdb-bridge.src.js` esbuild target** — 5-я цель в `esbuild.mjs` бандлит webview bridge с inlined `@duckdb/duckdb-wasm` + `apache-arrow` (~426 KB self-contained ESM). Output → `dist/media/`, ships in .vsix.
- **eslint config: `media/**` ignore** — webview asset JS не индексируется TypeScript projectService.

## [0.5.1] — 2026-05-08

Maintenance-релиз: wiring двух уже-готовых pure helper'ов в реальные UI-точки + накопленные за итерации `/roadmap-max` рефакторинги.

### Changed
- **Workspace lifecycle** — 4 команды (`suspendWorkspace` / `resumeWorkspace` / `freezeWorkspace` / `unfreezeWorkspace`) теперь используют единый `transitionWorkspaceSyncState` (state machine) через helper `validateWorkspaceTransition`. Inline-проверки `normalizeWorkspaceSyncState !== "X" || hasArchivedTag` заменены на централизованную валидацию. Отказы маппятся через `mapTransitionRejection(action, reason)` в ru-сообщения.
- **Onboarding wizard** — `vscodesync.startOnboarding` теперь использует `planOnboardingWizard` для skip-decisions: уже-настроенные шаги (провайдер / auth-токен / имя машины / подключённый workspace) пропускаются. При повторном запуске для уже-настроенного user'а показывается info-toast «VSCodeSync уже настроен» вместо прогона всех 4 шагов. В финальном toast'е перечисляются пропущенные шаги.
- **Snapshot retention manual flow** — pure planner `planSnapshotRetention` теперь подключён в manual `vscodesync.createSnapshot` (раньше работал только в scheduled пути). Workspace больше не накапливает снапшоты бесконечно через ручную команду.

### Fixed
- **Workspace state machine semantic** — `frozen.unfreeze` теперь резолвится напрямую в `active` (было `suspended`). Реальный flow `unfreeze` вызывает `repairLocalStateFromCloud` + `syncWorkspace`, оба заблокированы guard'ом `canSyncFromWorkspace` если destination = `suspended`. State machine была рассинхронизирована с UX.

### Internal
- 100+ коммитов после `v0.5.0`: `snoozeStore` консолидация в 3 UI-flow (machine approval, smart workspace suggestions, inactive archive); `findInactiveWorkspaceCandidates` дедуп между 2 UI-точками; webhook decoder + renew-tick wiring в OneDrive / Google Drive; `evaluateLongAbsence` + `planLocalBackupRetention` подключены в startup loop / pruneLocalBackups; cross-cutting pure helpers (P2P / passkey / tunnel / queue formatter / suspend state machine).
- Test count: **1604** unit-тестов (+77 новых test-файлов после `v0.5.0`).
- LoC дубликатов: -200+ через консолидацию через pure helpers.

## [0.5.0] — 2026-05-08

Большая функциональная волна за 9 проходов /roadmap-max: закрыты все
открытые пункты v1 roadmap, все 7 skeleton-фич Phase 12 «Quality pass»
доведены до полной реализации, разблокированы значимые куски v2
backlog (P2P crypto envelope, tunnel registry, конкретные фичи).

### Added — v2 progress
- WebRTC P2P crypto envelope: `src/core/p2pCryptoEnvelope.ts`
  (encodeP2PFrame / decodeP2PFrame, 8-байтовый clear header
  `[v=1][type:u8][seq:u32][reserved:u16=0]` + AES-256-GCM body, strict
  decoder с `{ ok, reason }`); `wrapAuthenticated` обёртка над
  `P2PChannel` с монотонным seq и replay-protection.
- Tunnel-провайдер registry: `tailscaleFunnelTunnelBackend` skeleton,
  оба backend'а (cloudflared + tailscale-funnel) зарегистрированы в
  `extension.ts:activate()`.
- CLI subpackage: `cli/vscodesync` для headless-sync без открытого VS Code
  (cmdAuth / cmdPull / cmdStatus, parseArgs, secret-store-env).

### Added — Phase 12 «Quality pass» полностью закрыта
- Bulk Push Wizard: команда `vscodesync.bulkPush` с QuickPick
  canPickMany + withProgress + OutputChannel `▶`/`✓`/`✗`;
  `engine.pushAll(workspaceId?, onProgress?): Promise<PushAllResult[]>`
  с двумя событиями на workspace.
- Hover Diff Preview: `HoverDiffPreviewProvider` со 5-сек TTL-кэшем,
  MarkdownString с trustedCommands `[Pull]` / `[Resolve Conflicts]`;
  setting `vscodesync.hoverDiffPreview.enabled`.
- Achievements: `runEvaluateAndPopup` (🏆 toast per новое достижение,
  persist в `globalState`), `runShowAchievements` OutputChannel;
  scheduleAchievementsWarmup (5-сек delay после activate). Команда
  `vscodesync.showAchievements`.
- Workspace Templates: `BUILT_IN_TEMPLATES` (Empty notes, Code
  snippets, Documentation) + `runInstallWorkspaceTemplate` (QuickPick
  → showOpenDialog → collision probe → modal → atomic-writes).
  Команда `vscodesync.installWorkspaceTemplate`.
- Snapshot Diff Viewer: `runSnapshotDiff` через встроенный
  `vscode.diff` editor (без webview). Команда `vscodesync.diffSnapshots`.
- Smart Conflict Prediction: `SmartConflictPredictionService` —
  status-bar warning при активном editor, чей файл уже помечен
  `editingBy` другой машиной через soft-lock pipeline. Setting
  `vscodesync.smartConflictPrediction.enabled`.
- Time Travel scrubber: webview с `<input type="range">` + `<pre>`
  viewer над `.history/{relPath}/`, monotonic sequence guard от race на
  медленный download. Команда `vscodesync.openTimeTravelScrubber`.

### Added — wiring + tooling
- Insights weekly digest: `buildWeeklyDigest` (агрегаты по
  kind/file/machine/workspace/day, busiest/quietest) + команда
  `vscodesync.showInsightsWeeklyDigest`.
- Stats Dashboard sankey "push → pull" (vanilla SVG, без D3) — команда
  `vscodesync.openSankeyChart`.
- Conflict heatmap CodeLens "flame" — `ConflictHotZoneCodeLensProvider`
  + real line ranges из inline-CodeLens
  (`vscodesync.{keepMine,takeTheirs}WithRange`).
- AI Path Mapper auto-prompt после `attachCloudWorkspace` (idempotent
  через globalState).
- Husky + lint-staged (`.husky/pre-commit`, `.lintstagedrc.json`).
- Centralised logger (`src/utils/log.ts`) routes verbose / warn / error
  output to the existing `OutputChannel` instead of `console.*`.
- Shared loopback PKCE OAuth flow (`src/providers/_shared/pkceLoopbackOAuth.ts`)
  используется OneDrive / Google Drive / Dropbox / Yandex.Disk.
- Welcome view в Workspaces tree, `Ctrl+Alt+W` quick-switch,
  Recently-changed smart group.
- `.editorconfig`, `SECURITY.md`, `CHANGELOG.md`, `.github/workflows/release.yml`.

### Changed
- `vscodesync.conflictRules` setting accepts `ConflictRule[]` objects
  matching the runtime schema (was misdeclared as `string[]`).
- `webhookTunnel.dispose()` reliably aborts the SSE stream and prevents
  reconnects (previously the disposed flag was never observed).
- `writeTextFileAtomic` Windows fallback writes to a sibling temp file
  before swapping.
- `normalizeLineEndings` collapses CRLF/CR in a single regex pass.

### Fixed
- `extension.web.ts` uses the correct extension id
  `borodatych.vscodesyncfiles` (previous id never resolved).
- `engineCallbacks > onNewConflict 3-way` test stabilised — clear etag
  when patching meta (ETag-cache short-circuit was masking the conflict).
- `syncRateLimitState` fallback off-by-1 (1-ms cushion in
  `noteProviderRateLimited`).
- Dead branch `provider === "onedrive" === "onedrive"` in
  `oneDriveWebhookLifecycle` removed.
- Duplicate `vscodesync.migrateProvider` command removed (kept the
  working `vscodesync.migrateToAnotherProvider`).
- Verbose `console.*` output removed from soft-lock, sync trigger
  manager, Yandex provider and startup paths.

### Removed
- Unused `vscodesync.fileEncoding` setting.
- All `*NotImplementedError` sentinels for fully-shipped Phase 12 features
  (Bulk Push, Hover Diff, Achievements, Workspace Templates, Snapshot Diff,
  Smart Conflict Prediction, Time Travel).

### Tests
- 716 / 0 passes (was 262 in 0.4.0). New direct coverage:
  `tests/unit/encryption.test.ts` (13), `tests/unit/syncAutoPause.test.ts`
  (9), плюс ~50 unit-тестов на новые pure helpers.

## [0.4.0] — 2026-05-07

- Initial public history milestone (see Git log for the path here).
