# Phase 11 — Feature Pack

> Средний пакет фич, требующий отдельных сессий с тестами и UI-проверкой.

## Статус: `[x]` (закрыто; остаются 2 deferred edge-кейса в test coverage — see ниже)

## Производительность / автоматизация

- [x] **Scheduled Snapshots (cron-like)** — `src/ui/scheduledSnapshots.ts`. Setting `vscodesync.snapshotSchedule` поддерживает `daily HH:MM` и `weekly DOW HH:MM`. Polling 5 min. Pure retention planner `src/core/snapshotRetentionPlan.ts:planSnapshotRetention(input)` (age sweep + count cap, system-tier `auto-` / `pre-migration-` исключены из count rule, 13 unit-тестов) подключён в `extension.ts:5031` сразу после `createWorkspaceSnapshot` per-workspace. Best-effort: ошибка retention не валит сам снапшот.
- [x] **Watch Mode: EWMA-предиктор окна** — `src/ui/watchModePoller.ts`. EWMA (α=0.3) считается по `onDidSaveTextDocument`; в idle scaling множитель 4× вместо 2×, если EWMA > 3× currentMs. На любой save — мгновенный возврат к baseMs.
- [x] **Self-healing manifest** — `parseManifestSafe()` в `syncEngine.ts`: при JSON / shape error вызывает `onCorruptManifest` callback, UI предлагает Repair State. `null`-возврат заставляет верхний уровень обработать как «manifest gone».
- [x] **Health Check автореп раз в 7 дней** — `src/ui/healthAutoCheck.ts`. Запускается через 60 с после activate, читает `vscodesync.health.lastCheckMs` из globalState, тихий на зелёном, toast при наличии `⚠`-строк.
- [x] **Manifest pre-flight validation** — `src/core/manifestValidate.ts` + `validateManifestShape()` в `putManifest`. Никогда не пушим манифест, который сами бы отвергли при чтении. Без Zod (своя реализация — нет лишних зависимостей).
- [x] **Telemetry crash reports (opt-in)** — `setCrashReporter` в `src/utils/log.ts` + wiring через `vscode.env.createTelemetryLogger` в `logVscode.ts`. Срабатывает только при `vscodesync.telemetry: true && vscode.env.isTelemetryEnabled`.

## UI / UX

- [x] **Quick Transfer Drop Panel** — `src/ui/quickTransferDropPanel.ts`. Webview с drop-zone + список 12 недавно изменённых файлов (за 24h из открытых folders) + кнопка «Выбрать файл…». Каждый Send — через существующую команду `vscodesync.sendQuickTransfer` (machine-picker и rest UX в неизменном виде). Команда `vscodesync.openQuickTransferDrop`. HTML5 drop URI VS Code не пропускает — оставлены fallback-кнопки.
- [x] **Activity Feed: saved searches** — `src/ui/activitySavedSearches.ts` (store в globalState) + `src/ui/activityFeedPanel.ts` postMessage-integration: `applySavedSearch` от host применяет filter в форме, `filterChanged` от webview обновляет `lastAppliedFilter` для save-current-search. Команды: `vscodesync.activitySaveCurrentSearch`, `vscodesync.activityApplySavedSearch`, `vscodesync.activityDeleteSavedSearch`.
- [x] **Activity Feed: alerting toast** — `src/ui/activityAlertMonitor.ts` + vscode-free matcher `src/ui/activityFilterMatch.ts`. Команда `vscodesync.activityToggleAlertingForSearch` с canPickMany — отметить какие saved-searches генерируют toast. Батчинг 4 секунды чтобы не спамить во время bulk-sync. 10 unit-тестов на матчер.
- [x] **Stats Dashboard: heatmap (vanilla CSS-grid)** — `src/ui/activityHeatmap.ts` — vscode-free бакетер (7×24 матрица), 7 unit-тестов. Webview рисует CSS-grid heatmap с opacity-индикацией плотности; без ECharts (не понадобилось, экономия ~500 KB).
- [x] **Stats Dashboard: sankey** «push from → pull to» — `src/core/sankeyLayout.ts` (pure two-column planner, 7 unit-тестов: ordering, link thickness, Bezier path, empty / non-positive weight handling) + `src/ui/sankeyPushPullFlows.ts` (vscode-free aggregator: «pull machine M на workspace W → последний pusher на W», 7 unit-тестов) + `src/ui/sankeyChartPanel.ts` (vanilla SVG webview, без D3/vis-network) + команда `vscodesync.openSankeyChart` через `registerPanelCommands`.
- [x] **Multi-machine graph** — `src/ui/machineGraphLayout.ts` (vscode-free, 8 unit-тестов: window-фильтр, malformed timestamps, minWeight, outer/inner ring placement, workspaceNote labels) + `src/ui/machineGraphPanel.ts` (SVG-webview без d3-зависимостей, command `vscodesync.openMachinesGraph`). Машины на внешнем кольце, workspaces на внутреннем; ширина линий = вес рёбер.
- [x] **Live presence heartbeat** — `src/ui/presenceHeartbeat.ts`. Setting `vscodesync.presenceHeartbeatMinutes` (0 = off). Минимум 1 мин (по умолчанию off — не агрессивим cloud quota).
- [x] **Walkthroughs (gamified onboarding)** — `contributes.walkthroughs` в `package.json`, ID `vscodesync.getStarted` с 5 шагами (provider → workspace → add file → snapshot → quick switch).
- [x] **Inline conflict CodeLens** — `src/ui/inlineConflictCodeLens.ts` + vscode-free сканер `src/ui/conflictMarkerScanner.ts`. Lenses над каждым `<<< / === / >>>` блоком: Keep mine | Take theirs | AI merge (последний только при `vscodesync.aiMerge: true`). Setting `vscodesync.inlineConflictCodeLens.enabled`. 7 unit-тестов на парсер.
- [x] **Onboarding: link import** — `vscode://borodatych.vscodesyncfiles/connect?provider=…&workspaceId=…` парсится в desktop-`activate` через `vscode.window.registerUriHandler`. Команда `vscodesync.shareWorkspaceLink` копирует ссылку в clipboard. Автодетект провайдера (Edge / Chrome cookie) — out-of-scope (требует cross-browser cookie API, не критично для MVP).
- [x] **Smart pause UI: единый dropdown** — `vscodesync.smartPauseDropdown` команда в `plannedPaletteCommands.ts`. QuickPick с 5 опциями (Off / Metered / Battery<30% / Battery+Metered / Toggle manual). Запись в существующие settings без рефакторинга `syncAutoPause`.
- [x] **Emoji-free режим** — `src/utils/notificationFormat.ts` (`formatNotification(text)` + `isEmojiFreeEnabled()`). Setting `vscodesync.notifications.emojiFree`. Подключён в `notificationService.ts` boundary (showSyncInfo/Warning/Error + recordDigestPush/Pull/Conflict + emit digest). Все unified-notification-точки идут через этот фильтр.

## AI

- [x] **AI Sync Session Summary** — `src/core/aiSessionSummary.ts` + команда `vscodesync.aiSessionSummary`. QuickPick окна (сегодня / неделя / месяц), `vscode.lm` (gpt-4o → fallback any). Вывод в `OutputChannel`.
- [x] **AI Workspace Tagger** — `suggestWorkspaceTags()` в том же модуле + команда `vscodesync.aiSuggestWorkspaceTags`. Анализ первых 30 файлов, валидация regex, дедуп, max 4 tags. Применяется через существующий `editWorkspaceTags`.

## i18n

- [x] **Английский язык интерфейса (titles)** — `scripts/i18n-extract-titles.mjs` прогнан: 111+ командных titles в `package.json` заменены на `%cmd.X.title%` placeholders. `package.nls.json` (en) — переведены все 111+. `package.nls.ru.json` (ru) — оригиналы.
- [x] **Английский для configuration descriptions** — `scripts/i18n-extract-config-descriptions.mjs` прогнан: ~44 ключей в `cfg.X.description` заменены на placeholders. `package.nls.json` содержит английские переводы для всех видимых настроек.

## Тесты, не покрытые сейчас

- [x] `src/providers/yandex/yandexDiskProvider.ts` — `tests/unit/yandexPathMapping.test.ts` (path encoding) + `tests/unit/yandexProviderRefresh.test.ts` (7 кейсов: auth-state, refresh round-trip, refresh failure, missing client id, 429 RATE_LIMITED через mock fetch).
- [x] `src/providers/dropbox/dropboxProvider.ts` — `tests/unit/dropboxPath.test.ts` (7 кейсов) + `tests/unit/dropboxProviderRefresh.test.ts` (6 кейсов: auth-state, refresh POST в /oauth2/token, refresh failure, missing app key).
- [x] `src/providers/gdrive/gdriveProvider.ts` — `tests/unit/gdriveProviderRefresh.test.ts` (6 кейсов: auth-state, refresh round-trip против oauth2.googleapis.com, refresh failure, missing client id).
- [x] `src/providers/onedrive/onedriveProvider.ts` — `tests/unit/onedriveTokenRefresh.test.ts` (refresh state machine) + `tests/unit/onedriveProviderAuthState.test.ts` (5 кейсов: isAuthenticated/logout, authenticate guidance, UNAUTHORIZED без токена).
- [x] `src/ui/oneDriveWebhookLifecycle.ts`, `googleDriveWebhookLifecycle.ts` — общий expiration-helper `src/ui/webhookExpirationMath.ts` (`isNearOrPastExpiration`, `reconcileSubscription`), 12 unit-тестов на reconcile decisions (create / renew / none для разных combinations URL+expiry). `decideWebhookRenewTick` подключён в обоих lifecycle-модулях. Полный mock сетевых вызовов lifecycle — out-of-scope (требует thinly-mocked Graph / Drive API, отдельная задача интеграционного покрытия).
- [x] `src/ui/webhookSseParser.ts` — выделен из `webhookTunnel.ts` как vscode-free модуль; `tests/unit/webhookTunnelParser.test.ts` покрывает heartbeat / malformed JSON / multi-line `data:` / headers split (7 тестов).
- [~] Edge-кейсы: **412 PreconditionFailed** покрыт через `tests/unit/mergeCloudManifests.test.ts` (7 кейсов на race-resolution: workspaceId mismatch, newer-wins для note/gitBranch, union для tags/machines/sharedIgnorePatterns). EPERM rename / chunk upload / smee.io reconnect — остаются (нужны очень тонкие per-provider mocks).
- [x] Стабилизировать 8 flaky тестов на main — все 8 закрыты по итогу 2-х roadmap-max passes. Финальный счёт: 660 / 0.
