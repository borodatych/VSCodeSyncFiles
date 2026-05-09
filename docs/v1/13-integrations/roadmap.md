# Phase 13 — Integrations + Reliability fixes

> Закрытие интеграционных хвостов из Phase 11/12 (wiring pure helpers в реальные UI-точки) + исправления reliability из аудита #3 (race в фоновых tick'ах) + продуктивные фичи 3-й волны (storage reporter, restore from cloud, garbage tracked detector).

## Статус: `[x]` (закрыто)

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

- [x] `engineCallbacks > onNewConflict 3-way` — оказался deterministic test bug, не race: тест подменял `meta.files[rel].hash` без обнуления `etag`. На стороне B `downloadFile(..., ifNoneMatch: cachedEtag)` отвечал `notModified=true` → `cloudCurrent` коллапсировал в base = "fake-base-hash" → проверка `localHash !== base && cloudCurrent === base` срабатывала и возвращала «cloud_newer» вместо «conflict». Фикс: в тесте обнулять `etag` вместе с подменой `hash`.
- [x] CodeLens поверх F-3.8 hot-зон — `src/ui/conflictHotZoneLensPlanner.ts` (pure: `planHotZoneLenses` со clamping на `lineCount-1` + сортировка top-to-bottom + `formatHotZoneLensTitle`, 9 unit-тестов) + `src/ui/conflictHotZoneCodeLens.ts` (`ConflictHotZoneCodeLensProvider` + `makeToRelPath`; 30-сек TTL-кэш, чтобы не читать `conflicts.json` на каждый refresh). Зарегистрирован в `extension.ts:1083+` рядом с `InlineConflictCodeLensProvider`. Setting `vscodesync.conflictHotZoneCodeLens.enabled` (default true). Real line ranges подключены через `vscodesync.{keepMine,takeTheirs}WithRange` internal commands из inline-CodeLens (см. ниже).
- [x] Real line ranges → conflict heatmap — internal-команды `vscodesync.keepMineWithRange` / `takeTheirsWithRange` принимают `{ startLine, endLine }` и вызывают `recordConflictResolution` с реальными границами блока перед делегированием в существующие `vscodesync.keepMine` / `takeTheirs`. `inlineConflictCodeLens.ts` теперь биндится на `*WithRange`-варианты и передаёт `block.startLine + 1` / `block.endLine + 1` (1-based). Старый global-hook, писавший `1..1` на каждое `resolve_*` activity event, удалён — heatmap теперь содержит только real ranges; tree- и palette-level resolve намеренно не пишутся, потому что не знают конкретного блока.
- [x] Auto-prompt F-3.5 на attachCloudWorkspace для новой машины — `maybePromptPathMapperAfterAttach(context, workspaceId)` в `src/ui/aiPathMapperCommand.ts`. Дёргается из обоих attach-flows в `src/extension.ts` (single workspace из tree + multi-pick из QuickPick). Idempotent через `globalState['vscodesync.aiPathMapper.promptedFor:<workspaceId>']` — показывается ровно один раз на машину × workspace. Soft-skip при отсутствии `vscode.lm`.
- [x] Snapshot Diff Viewer / Time Travel scrubber / Hover Diff Preview / Workspace Templates — закрыты в Phase 12 «Quality pass»: все 4 sentinels удалены, фичи доведены до полной реализации. См. [`12-quality-pass/roadmap.md`](../12-quality-pass/roadmap.md).
