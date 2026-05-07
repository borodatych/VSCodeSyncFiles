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

## Skeletons (готовы pure shapes + sentinel; UI ждёт реализации)

- [~] **Snapshot Diff Viewer** — `src/core/snapshotDiffViewer.ts` (`planSnapshotDiff`, `SnapshotDiffViewerNotImplementedError`). Что осталось: webview side-by-side с diff-рендером.
- [~] **Time Travel scrubber** — `src/core/timeTravelScrubber.ts` (`buildTimeTravelModel` со slider tick'ами, `TimeTravelScrubberNotImplementedError`). Что осталось: slider-widget + binding к `.history/{path}/`.
- [~] **Smart Conflict Prediction** — `src/core/smartConflictPrediction.ts` (`scoreConflictRisk`, `SmartConflictPredictionNotImplementedError`). Что осталось: presence-wire `editingBy[path]` через `_machines.json` + heartbeat propagation.
- [x] **Bulk Push Wizard** — `engine.pushAll(workspaceId?, onProgress?): Promise<PushAllResult[]>` (поддерживает `workspace_started` / `workspace_finished` события, throws как раньше — UI оборачивает per-workspace try/catch). Pure helpers `planBulkPush` / `summariseBulkPushResults` / `formatBulkPushResults` в `src/core/bulkPushWizard.ts` (5 unit-тестов). Команда `vscodesync.bulkPush` в `extension.ts` — QuickPick `canPickMany` поверх workspace'ов с pendingFiles > 0, `withProgress` notification + OutputChannel `VSCodeSync · Bulk Push` с per-workspace `▶` / `✓` / `✗` строками + финальным `formatBulkPushResults`. Отдельная от существующей `vscodesync.pushAll` (которая молча проходит без UI).
- [x] **Hover Diff Preview** — `src/core/hoverDiffPreview.ts` расширен `summariseHoverDiffMinimal` (pure: cloud_newer / conflict / ok формулировки + age-in-words с минута/час/день масштабом, 7 unit-тестов). `src/ui/hoverDiffPreviewProvider.ts` — `HoverProvider` со 5-сек TTL-кэшем по URI; читает только локальный `WorkspaceConfigManager` (без provider round-trips, без download blob). MarkdownString hover с trustedCommands → `[Pull]` для cloud_newer / `[Resolve Conflicts]` для conflict. Setting `vscodesync.hoverDiffPreview.enabled` (default true). Sentinel `HoverDiffPreviewNotImplementedError` удалён.
- [x] **Workspace Templates** — `src/core/workspaceTemplates.ts` дополнен `planTemplateInstall(t, targetFolder)` (re-runs path-traversal guard at install) + `BUILT_IN_TEMPLATES` каталог из 3-х шаблонов (Empty notes / Code snippets / Documentation). `src/ui/workspaceTemplatesCommand.ts` — `runInstallWorkspaceTemplate`: QuickPick → showOpenDialog → collision probe → modal Перезаписать/Пропустить/Cancel → atomic-writes через `writeTextFileAtomic`. Команда `vscodesync.installWorkspaceTemplate`. Sentinel `WorkspaceTemplatesNotImplementedError` удалён. +3 unit-теста (planTemplateInstall map, traversal-guard at install, BUILT_IN_TEMPLATES validate).
- [x] **Achievements** — `src/core/achievements.ts` (`evaluateAchievements` для first-push/first-pull/100-pushes/5-machines + `newlyUnlocked` для diff с persisted set). `src/ui/achievementsService.ts` — `runEvaluateAndPopup` (реал-toast 🏆 per новое достижение, persist в `globalState['vscodesync.achievements.unlockedIds']`), `runShowAchievements` (OutputChannel список с lock state), `scheduleAchievementsWarmup` (5-сек задержка после activate, чтобы не пересекаться с activation toast). Команда `vscodesync.showAchievements`. Sentinel `AchievementsNotImplementedError` удалён.
- [x] **Insights weekly digest** — `src/core/insightsWeeklyDigest.ts` (pure: `buildWeeklyDigest / formatWeeklyDigest`, 9 unit-тестов; window 7 дней, агрегаты по kind/file/machine/workspace/day, busiest/quietest) + команда `vscodesync.showInsightsWeeklyDigest`.
- [x] Wiring F1/F2/F3/F5 в реальные UI-points — закрыто в Phase 13 как W1–W5 (sparkline → status bar; online indicator → quick-transfer; mass-delete guard → putManifest pre-flight; AI commit message → snapshot InputBox; formatNotification → unified notifications + digest).

Скелетные тесты: `tests/unit/skeletonSentinels.test.ts` (18 кейсов) — гарантируют, что pure shapes работают и что вызов незакрытой UI-точки бросает свой `*NotImplementedError`.

## Что НЕ сделано (blocked)

- [x] `engineCallbacks > onNewConflict 3-way` — починен на 2-м roadmap-max pass; см. фазу 13. Был bug в тесте (etag не обнулялся при подмене meta.hash → ETag-cache short-circuit маскировал conflict).
