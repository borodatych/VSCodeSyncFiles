# Phase 12 — Quality pass + safety features

> Чистка после 11 волн: устранение дубликатов / dead-code, явные `@experimental`-маркеры на skeleton-модули, новые safety-фичи (mass-delete guard, queue dedupe), и UX-полировки (sparkline, online-indicator, AI commit messages).

## Статус: `[x]` (закрыто в этой сессии)

## Аудит-фиксы (C1-C5)

- [x] **C1. webviewNonce common helper** — `src/utils/webviewNonce.ts` (`getWebviewNonce()`); 4 копии `getNonce()` удалены из `statsDashboardPanel`, `activityFeedPanel`, `machineGraphPanel`, `quickTransferDropPanel`.
- [x] **C2. @experimental JSDoc на skeleton-модули** — `keyEnvelope.ts`, `p2pSignaling.ts`, `p2pDataChannel.ts`, `wireCodec.ts`, `hashProviders.ts`, `tokenExpiryHints.ts`. Будущим читателям не соблазн «удалить как dead code».
- [x] **C3. wireZstd manifest gate** — `assertSupportedCodec(flags)` в `src/core/wireCodec.ts`. По умолчанию список = `["raw", "gzip"]`; `wireZstd: true` rejected до v2.3 read-path. Тесты (4 кейса) на boundary cases.
- [x] **C4. ActivityAlertMonitor disposed race** — флаг `disposed` + early return в `flush()`-callback после `showInformationMessage().then(...)`. Защита от race с deactivate.
- [x] **C5. googleDriveWebhookLifecycle reconcile** — `reconcileFromFlags()` (provider-format-agnostic вариант) подключён в `googleDriveWebhookLifecycle.ts`. OneDrive lifecycle уже использует ISO-вариант `reconcileSubscription`.
- [x] **Wiring M5/M6**: `tokenExpiryHints.classifyExpiry` подключён в OneDrive startup-warning (raз 7 дней до expiresAt + expired). `webhookExpirationMath.isNearOrPastExpiration` заменил локальный duplicate в `oneDriveWebhookLifecycle.ts`.

## Новые safety-фичи

- [x] **F3. Anomaly mass-delete guard** — `src/core/massChangeGuard.ts` (`detectMassChange / describeMassChange / DEFAULT_ABSOLUTE_THRESHOLD=25 / DEFAULT_PERCENT_THRESHOLD=0.5`). Pure helper: сравнивает prev и next manifests, возвращает `MassChangeReport` с `triggered / newlyRemoved / reason`. 11 unit-тестов. Wiring в `putManifest` pre-flight — следующая итерация (нужно решение, как surface confirmation modal без блокирующего синхронного flow).
- [x] **F4. Offline queue self-healing dedupe** — `dedupeOfflineQueue()` в `syncOfflineQueueStore.ts`. Группирует по `{kind, root, rel, workspaceId}`, выбирает последнее, переносит флаг `priority` если был на любой из дубликатов. Подключено в `drainSnapshot()` ПЕРЕД priority-sort. 8 unit-тестов (5× push collapse, push-vs-pull, fullSync head, qt tail, Windows path normalization).

## UX-фичи

- [x] **F1. Sync Sparkline** — `src/utils/sparkline.ts` (`sparkline()` + `bucketHourly()`). Unicode block-chars `▁▂▃▄▅▆▇█`, ~80 LoC. 11 unit-тестов. Integration в Status Bar — отдельной волной (требует читать activity log в `statusBar.refresh`).
- [x] **F2. Multi-machine Online Indicator** — `src/ui/machinePresenceStatus.ts` (`classifyPresence` → online/recent/offline по lastSeen, `describePresence` для tooltip). 11 unit-тестов на boundary windows + clock-skew. Tree-integration (ThemeColor dot icon) — следующая итерация.
- [x] **F5. AI commit message helper** — `src/core/aiCommitPrompt.ts` (vscode-free `buildCommitPrompt / truncatePath / MAX_FILES=30 / MAX_PATH_LEN=80`, 10 unit-тестов) + `src/core/aiCommitMessage.ts` (LM-обвязка, lazy-load, fail-soft через `vscode.lm`). Pre-fill для snapshot/quick-transfer notes. Integration в command flows — следующая итерация.

## Что НЕ сделано (отложено / blocked)

- [ ] Snapshot Diff Viewer (M) — большой webview, требует UI-итерации
- [ ] Time Travel scrubber (L) — тяжёлый UI с slider
- [ ] Smart Conflict Prediction (M) — требует расширения `editingBy[path]` и presence wire
- [ ] Bulk Push Wizard (M) — требует engine.pushAll progress callback
- [ ] Hover Diff Preview (M) — требует API «diff summary без раскачки blob»
- [~] Workspace Templates / Achievements / **Insights weekly digest** — Insights weekly digest сделан: `src/core/insightsWeeklyDigest.ts` (pure: `buildWeeklyDigest / formatWeeklyDigest`, 9 unit-тестов; window 7 дней по умолчанию, агрегаты по kind / file / machine / workspace / day, busiest/quietest day) + команда `vscodesync.showInsightsWeeklyDigest` (OutputChannel). Templates / Achievements — пока skeleton-ниша (см. отдельный пункт).
- [x] Wiring F1/F2/F3/F5 в реальные UI-points — закрыто в Phase 13 как W1–W5 (sparkline → status bar; online indicator → quick-transfer; mass-delete guard → putManifest pre-flight; AI commit message → snapshot InputBox; formatNotification → unified notifications + digest).
- [ ] 1 hard flaky test `engineCallbacks > onNewConflict 3-way`
