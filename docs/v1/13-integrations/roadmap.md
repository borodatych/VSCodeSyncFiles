# Phase 13 — Integrations + Reliability fixes

> Закрытие интеграционных хвостов из Phase 11/12 (wiring pure helpers в реальные UI-точки) + исправления reliability из аудита #3 (race в фоновых tick'ах) + продуктивные фичи 3-й волны (storage reporter, restore from cloud, garbage tracked detector).

## Статус: `[~]` (в работе)

## Reliability fixes (audit #3)

- [x] **A1. Race-guard в `presenceHeartbeat`** — `running` флаг в `tick()`. Защита от наложенных вызовов при cloud latency > interval (дублирование записи в `_machines.json`).
- [x] **A2. Race-guard в `crossCloudBackup`** — `running` флаг в registerCrossCloudBackup. Защита от наложенных tick'ов при медленном primary listFolder/копировании.

## Wiring (Quality pass tail)

- [x] **W1. F1 Sparkline → Status Bar** — `buildSparkSuffix(storageDir)` в `statusBar.ts`. Читает `loadActivityFile`, фильтрует push/pull, передаёт в `bucketHourly` + `sparkline`. TTL-кэш 60 с (избегает чтения файла на каждом refresh). Suffix вставляется между offline/Watch и `$(clock)`.
- [x] **W2. F2 Online indicator → Quick Transfer picker + tooltip** — `quickTransferUi.ts` machine-picker: `$(circle-filled)` online (≤5 мин) / `$(circle-outline)` recent (≤24 ч) / `$(circle-slash)` offline. Description через `describePresence`. `workspaceMachinePresence.machinePresenceEmoji` теперь делегирует в `classifyPresence` — единые окна на всех UI-точках.
- [x] **W3. F3 Mass-delete guard → putManifest pre-flight** — добавлен `onMassChange?: (workspaceId, MassChangeReport) => Promise<boolean>` в `SyncEngineDeps`. Хук в `syncEngine.putManifest` ПЕРЕД uploadFile (только при `retries === 3` — на 412 retry не пере-спрашиваем). UI-callback в `extension.ts`: модалка с двумя выборами (создать snapshot + продолжить / продолжить без). Setting `vscodesync.massChangeGuard` (default: true). i18n en/ru.
- [x] **W4. F5 AI commit message → createSnapshot InputBox** — `plannedPaletteCommands.ts` createSnapshot: lazy-load `aiCommitMessage`, pre-fill `value` в InputBox (только если `vscodesync.aiMerge` on). Fail-soft при отсутствии vscode.lm.
- [x] **W5. formatNotification wiring** — все unified `showSync*Info/Warning/Error` + digest paths (`recordDigestPush/Pull/Conflict`, `emit digest`) теперь идут через `formatNotification`. Setting `vscodesync.notifications.emojiFree` стал реально активной фичей.

## Pure helpers + thin wrappers (3-я волна, roadmap-max pass)

- [x] **F-3.1. AI Garbage Tracked Detector** — `src/core/aiGarbageTrackedDetector.ts` (pure: 13 правил, churn/size бонусы, 8 unit-тестов) + команда `vscodesync.detectGarbageTracked`. Анализирует manifest + activity push counts (последние 30 дней) → ранжирует кандидатов → выводит в OutputChannel + опциональный copy `.vscodesync.ignore` patterns в clipboard.
- [x] **F-3.2. Editor Gutter Sync Status** — `src/ui/fileDecorations.ts` (`SyncFileDecorationController`). Уже было реализовано в Phase 3-7; статусы ⚠ / ↑ / ↓ / ✓ через `gitDecoration.*` ThemeColor. Зарегистрировано в `extension.ts:1052`.
- [x] **F-3.3. Restore from Cloud-Only** — `vscodesync.restoreFromCloud` команда. QuickPick облачных workspace'ов через `src/core/cloudWorkspaceLister.ts` → пользователь выбирает целевую папку → `runCloudExportFlow` → опциональный «открыть как workspace». Reuse `src/core/workspaceExportPlan.ts`.
- [x] **F-3.4. Workspace Export-to-Folder** — `vscodesync.exportWorkspaceToFolder` команда. Тот же `runCloudExportFlow` helper. Pure planner `src/core/workspaceExportPlan.ts` (`planWorkspaceExport / escapingPaths`, защита от path traversal, 8 тестов).
- [x] **F-3.5. AI Path Mapper** — `src/core/aiPathMapper.ts` (pure: `findSuspiciousPaths / buildPathMapperPrompt / parseRemapEdits / applyRemapEdits`, 9 unit-тестов) + `src/ui/aiPathMapperCommand.ts` (vscode.lm bridge). Команда `vscodesync.aiPathMapper`: пользователь вводит старый root → анализ конфигов → LM-предложения → подтверждение → запись на диск. Auto-prompt после attachCloudWorkspace — отложено как не критичное.
- [x] **F-3.6. Sync Replay Recorder** — `src/core/syncReplayRecorder.ts` (pure, 9 тестов) + `src/ui/syncReplayRecorderState.ts` (module-level state) + команды `startSyncRecording` / `stopSyncRecording`. Hook в `logSyncActivityRef` (`extension.ts`) активируется только если recording on. JSON сохраняется в `{storageDir}/replay-{uuid}.json`.
- [x] **F-3.7. Storage Usage Reporter** — `src/core/storageUsageReport.ts` (pure: `buildStorageUsageReport / formatBytes`, 11 unit-тестов) + команда `vscodesync.showStorageReport`. Рекурсивно walks CLOUD_ROOT_DIR (depth ≤ 4) → агрегация per-workspace + top-10 крупнейших → OutputChannel.
- [x] **F-3.8. Conflict Heatmap** — `src/core/conflictHeatmapStore.ts` (pure: `appendConflictEntry / buildHotZones`, retention 180 дн, кластеризация overlapping ranges, 8 unit-тестов) + `src/ui/conflictHeatmapStoreFs.ts` (file I/O wrapper) + hook в `logSyncActivityRef` для `resolve_keep_mine`/`resolve_take_theirs` событий. Команда `vscodesync.showConflictHeatmap` выводит топ горячих файлов в OutputChannel. CodeLens поверх hot-зон — отложено (нужны line ranges из conflict resolution flow).

## Reliability fixes (roadmap-max pass)

- [x] **A3. Rate-limit fallback off-by-1** — `src/core/syncRateLimitState.ts`. После `noteProviderRateLimited(undefined)` `getRateLimitRemainingMs()` могло вернуть 14 999 ms вместо 15 000 ms из-за sub-ms drift между двумя `Date.now()` в одном tick'е. Добавлен +1 ms cushion в `blockedUntilMs`. Тест `syncRateLimitState — falls back to exponential backoff …` теперь стабильно зелёный.

## Что НЕ сделано (blocked / отложено)

- [ ] 1 hard flaky test `engineCallbacks > onNewConflict 3-way` (мета-патч race) — отложено.
- [ ] CodeLens поверх F-3.8 hot-зон — нужны line ranges из conflict resolution flow (сейчас heatmap собирает file-level entries 1..1).
- [x] Auto-prompt F-3.5 на attachCloudWorkspace для новой машины — `maybePromptPathMapperAfterAttach(context, workspaceId)` в `src/ui/aiPathMapperCommand.ts`. Дёргается из обоих attach-flows в `src/extension.ts` (single workspace из tree + multi-pick из QuickPick). Idempotent через `globalState['vscodesync.aiPathMapper.promptedFor:<workspaceId>']` — показывается ровно один раз на машину × workspace. Soft-skip при отсутствии `vscode.lm`.
- [ ] Snapshot Diff Viewer / Time Travel scrubber / Hover Diff Preview / Workspace Templates — skeleton-bucket из Phase 12.
