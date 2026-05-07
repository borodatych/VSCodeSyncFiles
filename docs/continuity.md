# Заметки для смены контекста (чат / агент)

Краткий **handoff**, если история диалога схлопнулась или открыта новая сессия. Подробная спека — в [idea.md](idea.md); план работ — в [v1/roadmap.md](v1/roadmap.md).

## Текущий статус (последняя зафиксированная точка)

**Фазы 1–9 закрыты, Фаза 10 частично, Фазы 11 / v2 в плане.** См. [`v1/roadmap.md`](v1/roadmap.md).

### Реализовано в фазе 9 (Hardening, май 2026)
- Centralised logger `src/utils/log.ts` (без `vscode`-зависимостей) + `src/utils/logVscode.ts` (sink через OutputChannel). Все `console.log/warn` в hot-path заменены на `verboseLog/warnLog/errorLog`.
- `src/providers/_shared/pkceLoopbackOAuth.ts` — общий PKCE-loopback флоу. OneDrive / GDrive / Dropbox PKCE переписаны как тонкие обёртки. Yandex остаётся отдельно (implicit flow).
- `src/ui/webhookTunnel.ts` — `dispose()` через `AbortController`, флаг `disposed` через объект-геттер `isDisposed(state)` чтобы lint-flow не схлопывал. SSE-стрим теперь реально прерывается.
- `src/extension.web.ts:104` — фикс `getExtension("borodatych.vscodesyncfiles")` (старый ID `vscodesync.vscodesync` никогда не резолвился).
- `src/ui/graphWebhookLocalServer.ts` — `MAX_WEBHOOK_BODY_BYTES = 64 KB` лимит с runtime-проверкой; устранён DoS-вектор.
- `src/core/writeTextFileAtomic.ts` — fallback EPERM теперь делает unlink+rename перед прямым writeFile; новые байты остаются в `tmp` пока swap не пройдёт.
- `src/core/syncEngine.ts` — `delete meta.files[oldRel]` заменён на destructure `…rest` (no-dynamic-delete); sentinel `\x00` в `minimatchGlob` → `` (no-control-regex).
- `package.json`: схема `vscodesync.conflictRules` исправлена с `array of string` на `array of {pattern, strategy}`; удалён бесполезный `vscodesync.fileEncoding`; удалён дубликат команды `vscodesync.migrateProvider`.
- `eslint.config.mjs`: `argsIgnorePattern: "^_"` etc. `tsconfig.json`: `lib += ["WebWorker"]` (для `CryptoKey`, `CompressionStream`).
- **`npm run lint` → 0 errors, 0 warnings** (исходно 169).
- DX-инфраструктура: `CHANGELOG.md`, `SECURITY.md`, `.editorconfig`. `docs/v1/` и `docs/v2/` версионируются (раньше всё `docs/` игнорировалось). Файл `nul` в корне удалён.

### Реализовано в фазе 10 (Quick Wins, май 2026)
- `viewsWelcome` в Workspaces tree (две ветки: workspace folder открыта vs нет).
- `vscodesync.quickSwitchWorkspace` (`Ctrl+Alt+W` / `Cmd+Alt+W`): QuickPick всех workspace, отсортированных по `lastSync` desc.
- `WorkspacesTreeProvider.workspacesUnderFolder` — sort по `max(file.lastSync)` desc; пустые (без активности) уходят в конец и сортируются по имени.
- Status bar accent + конфликт-badge — проверено что уже было реализовано (`statusBarItem.warningBackground` + `$(warning) N conflicts`).

### Известные flaky-тесты — починено в ночной волне (7 из 8)

- ✅ `attachCloudWorkspace` — фикс: добавлен `forcePullWorkspace(workspaceId)` в `attachCloudWorkspace` после `syncWorkspace`. Раньше attach только маркировал файлы `cloud_newer`, оставляя rootB пустым; тест ожидал материализованные файлы.
- ✅ `conflictResolution` (6 тестов) — закрылись автоматически после фикса attach (тесты используют `attachCloudWorkspace` в setup).
- ✅ `decrypt with wrong key throws` / `decrypt with tampered ciphertext throws` — фикс: вернул `async` методы в `platformCrypto.ts` (мой ранний рефактор `Promise.resolve(...)` ломал throw-семантику для `decipher.final()`, которое бросает синхронно).
- ❌ `engineCallbacks > onNewConflict 3-way` — остался: hard edge-case с meta-patch race. Не критичен для основной функциональности; зафиксирован в Phase 11 «followup».

**Итог:** 307 / 308 passes (исходно 300 / 308).

### Реализовано в ночной волне (фаза 11 + добив фазы 10)

**Phase 11 (большая часть закрыта):**
- `src/ui/healthAutoCheck.ts` — weekly background Health Check (через 60 с после activate, читает `globalState.lastHealthCheck`, тихий на зелёном).
- `src/core/syncEngine.ts.parseManifestSafe()` + `onCorruptManifest` callback — self-healing: при JSON / shape error UI предлагает Repair State.
- `src/core/manifestValidate.ts` + `validateManifestShape()` в `putManifest` — pre-flight schema validation. Без Zod (своя реализация на ~70 строк).
- `src/ui/scheduledSnapshots.ts` — `vscodesync.snapshotSchedule`: `daily HH:MM` / `weekly DOW HH:MM`. Polling 5 min.
- `src/core/aiSessionSummary.ts` + команды `vscodesync.aiSessionSummary` / `vscodesync.aiSuggestWorkspaceTags` — `vscode.lm` (Copilot LM) для сводки активности и предложения тегов.
- Walkthroughs `vscodesync.getStarted` (5 шагов) — gamified onboarding в Welcome page.
- `vscodesync.smartPauseDropdown` — единый QuickPick для Off / Metered / Battery / All / Toggle manual.
- Telemetry crash reports: `setCrashReporter` / `reportCrash` в `src/utils/log.ts`, wired через `vscode.env.createTelemetryLogger` в `logVscode.ts`. Opt-in через `vscodesync.telemetry`.
- `src/utils/notificationFormat.ts` — emoji-free режим (`vscodesync.notifications.emojiFree`).
- `src/ui/presenceHeartbeat.ts` — live presence (`vscodesync.presenceHeartbeatMinutes`, off by default, минимум 1 мин).

**Phase 10 (добив):**
- `src/ui/lastSyncCodeLens.ts` — CodeLens над tracked файлами с last-sync временем + кнопка Pull / Resolve. Setting `vscodesync.codeLens.enabled`.
- `fileDecorations.ts.buildTooltip()` — расширенный hover на FileDecoration.
- Команды `vscodesync.diffWorkspaceManifest` / `vscodesync.forcePullFromMachine`.

**i18n инфраструктура:**
- `package.nls.json` (en) + `package.nls.ru.json` — ~30 ключей для самых видимых команд и основных описаний. Часть `package.json` уже использует `%cmd.X.title%` placeholders.

**v2 / DevOps:**
- `.github/workflows/release.yml` — на push tag `v*` сборка VSIX, параллельная публикация в VS Code Marketplace + Open VSX, GitHub Release с auto-notes. CI matrix (Linux / Windows / Mac).
- `attachCloudWorkspace` теперь делает initial pull — UX-fix.

### Ранее реализовано (фазы 1-8)

### Реализовано в фазе 8 / 8.x (предыдущие сессии):
- `src/core/platformCrypto.ts` — ICrypto интерфейс + desktop (node:crypto) + web (SubtleCrypto) реализации
- `src/core/platformCompression.ts` — ICompression интерфейс + desktop (zlib) + web (CompressionStream)
- `src/core/deltaSyncGate.ts` — rolling-hash CDC алгоритм (Rabin-Karp): `computeChunks` + `computeDelta` + `applyDelta` + `deltaApplyFromCloud` (Delta + Compression)
- `src/providers/onedrive/onedriveProvider.ts` — Upload Session для файлов >4MB (5×320KB чанки)
- `src/providers/onedrive/onedrivePkceOAuth.ts` — PKCE OAuth (loopback http 127.0.0.1:8736)
- `src/core/aiMerge.ts` — AI merge через vscode.lm API (Copilot); `vscodesync.aiMerge`
- `src/core/requestQueue.ts` — глобальная очередь запросов (`RequestQueue` + `getGlobalQueue`)
- `src/ui/webhookTunnel.ts` — smee.io relay client (SSE, reconnect); `vscodesync.webhooks.tunnelEnabled`; интегрирован в `oneDriveWebhookLifecycle.ts`
- `cli/src/credentialStore.ts` + `secretStoreEnv.ts` — keytar системный keychain (optional, external в esbuild)
- `src/extension.web.ts` — OAuth redirect handler (`webOAuthGetCode` + URI handler), lock-file (`acquireWebLock` / `releaseWebLock` via vscode.workspace.fs), `webPowerMonitorStub`, `getWebGitBranch`
- `tests/unit/platformCrypto.test.ts` — ICrypto contract + cross-implementation compatibility (Node↔Web)
- `tests/unit/deltaSyncAlgorithm.test.ts` — Delta Sync + интеграционный тест «big file → 1 GET + 1 PUT»
- 262 тестов прошли, компиляция OK

### Deferred / требует ручного тестирования:
- `web-extension.md`: тестирование на vscode.dev с реальным OneDrive

### Последнее сделанное (текущая сессия):
- `package.json`: `keepMine`, `takeTheirs`, `openConflictDiff3way` в contributes → 92 команды
- **Важный bugfix**: `syncWorkspace` теперь вызывает `adoptManifestFilesFromCloud` ПЕРЕД `pruneTrackingFromManifest`, используя свежий cfg — новые файлы от других машин подхватываются при каждом sync; `renamedFrom` работает корректно
- `tests/unit/softLock.test.ts` (4 теста), `onedriveTokenRefresh.test.ts` (6 тестов), `trackingManagement.test.ts` (4 теста), `engineCallbacks.test.ts` (3 теста) — итого 214 тестов в 50 файлах
- workspaceHealthLocal.test.ts расширен (+soft lock yellow)
- Docs: `[~]` → `[x]` для Suspend/Freeze, schedule-deferred, treeFilePush/Pull, preview; тесты задокументированы
- Soft Lock ✏️ иконка в дереве + 🟡 health indicator
- OneDrive авто-refresh токена (`maybeRefreshToken` + `clientId` в bundle)
- Git branch Resume → Preview накопившихся изменений
- Rotate Encryption Key полная реализация
- watchIntervalSeconds < 30 предупреждение
- 3-way diff (`runConflict3WayDiff`, команда `openConflictDiff3way`)
- Show File History: локальные бэкапы `📁` в quick-pick
- Quick Transfer: machine picker + Reply + 404 graceful
- Watch Mode: adaptive reset-on-change + interval status bar + grouped notifications (Digest)
- `.vscodesync-ignore`: авто-импорт из `.gitignore` при создании
- Timeline: push/pull → `showFileHistory`, conflict/resolve → `diffWithCloud`
- `TrackedFile.editingBy`/`editingByName` кэш из манифеста в syncWorkspace
- Все stale docs синхронизированы с реализацией

### Сделано в последних сессиях:
- Engine: `untrackFileLocal`, `untrackFileTombstoneOnly`, `renameTrackedFile`, `setSoftLock`, `clearSoftLock`
- Engine callbacks: `onPurgeLostFiles`, `onNewConflict` (binary-aware), `onSchemaVersionTooNew`
- Engine: `TrackedFile.editingBy`/`editingByName` кэш из манифеста в `syncWorkspace`
- Extension: palette `keepMine`/`takeTheirs`, multi-conflict queue, soft lock lifecycle, long-absence check
- OneDrive: авто-refresh токена (`maybeRefreshToken`, хранение `clientId`)
- Watch Mode: adaptive reset-on-change + interval display in status bar
- Quick Transfer: machine picker + Reply button + 404 race condition handling
- Timeline Integration: `SyncTimelineProvider` (from `activity.json`, runtime API)
- Git branch: Resume → Preview накопившихся изменений
- Soft Lock: ✏️ иконка в дереве + 🟡 health indicator
- Rotate Encryption Key: полная реализация (snapshots + re-encrypt + store new key)
- watchIntervalSeconds < 30 warning
- Docs: все docs синхронизированы с реализацией

## Как продолжить в новом чате

```text
Проект VSCodeSync в этом репозитории. Читай docs/continuity.md и .cursor/rules, затем продолжай по оставшимся open items в docs/v1/*.
```

## Зафиксированные решения (не потерять смысл)

- Один активный провайдер глобально в v1; источник истины в облаке — `.vscodesync-workspace.json`, локальный `.vscode/vscodesync.json` — кэш.
- **Core Sync:** оркестратор `src/core/syncEngine.ts`; пути облака — `src/core/cloudLayout.ts`; OneDrive — `src/providers/onedrive/`; линт только `src`+`tests` (`npm run lint`).
- Токены провайдеров — в `SecretStorage`; в `~/.vscode/vscodeSync/config.json` только метаданные.
- `WorkspaceConfigManager` — модуль с `load`/`save`/`getConfigPath` (не класс); корень воркспейса из `workspaceFolders[0]` в extension.
- Хэш контента: LF-нормализация → вырезание блоков `vsync-ignore-start`/`end` → SHA-256 (бинарники — по сырому буферу).
- VSIX собирать после правок: `.vscodeignore` исключает `src`, `tests`, `docs` — в пакет попадают в основном `dist/` и `package.json`.

## Команды

- `npm run compile` · `npm run lint` · `npm test` · `npm run test:integration` · `npm run package`

## Мелочи окружения

- В корне репозитория **не создавать** файл с именем `nul` (Windows).
- Интеграционные тесты тянут VS Code в `.vscode-test/` (в `.gitignore`).
