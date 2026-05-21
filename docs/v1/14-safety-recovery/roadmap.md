# Фаза 14: Safety & Recovery (v0.8)

> **Цель:** убрать пути, на которых пользователь может молча потерять данные. Все деструктивные действия — с автоматическим откатом, все провайдерные сбои — с понятным сообщением и actionable кнопкой, все listFolder-ы — без тихого truncate.

**Зависимости:** v0.7 (autoSyncMode, batched cfg writes)
**Следующая фаза:** [15-observability](../15-observability/roadmap.md)

---

## 14.1 Auto-snapshot перед destructive ops (F-001)

- [ ] Перед `restoreWorkspaceSnapshot` создавать `auto-pre-restore-<ts>` (новый kind `auto_pre_restore` в `snapshotsEngine`)
- [ ] Перед `aiMerge` записать undo-blob в `.history/<file>/auto-pre-aimerge-<ts>`
- [ ] Перед batch take-theirs (mass conflict resolve) — snapshot всего workspace
- [ ] Setting `vscodesync.safety.autoPreOpSnapshot` (default `true`) для отключения
- [ ] UI: success-сообщение содержит «Откатить → выполнить Restore Snapshot `auto-pre-...`»
- [ ] Unit-тесты на каждый из трёх путей

## 14.2 Quota exhaustion handling (F-002)

- [x] Расширить `ProviderError.code` enum: `STORAGE_QUOTA_EXCEEDED`
- [ ] Мапперы в провайдерах:
  - [ ] OneDrive: `quotaLimitReached` / `storageLimitReached` (Graph 507)
  - [ ] GDrive: `storageQuotaExceeded`
  - [ ] Yandex: `DiskSpaceError` (HTTP 507)
  - [ ] Dropbox: `path.write_conflict` / `path.insufficient_space`
- [ ] UI-баннер «Облако {provider} переполнено» с топ-5 самых тяжёлых файлов
- [ ] Кнопки: «Снять с синхронизации», «Сжать историю (.history rotation = 3)», «Сменить провайдер»
- [x] Pure planner `quotaExhaustionPlanner` — список heaviest файлов по `_meta.json` + `getMetadata`
- [x] Unit-тесты планнера (`tests/unit/quotaExhaustionPlanner.test.ts`)
- [ ] e2e mock-провайдер с 507 (deferred — нужны integration tests)
- [ ] UI-баннер «Облако {provider} переполнено» с топ-5 файлов (deferred — UI wiring)

## 14.3 Repair cloud manifest (F-003)

- [ ] Команда `vscodesync.repairCloudManifest` (deferred — UI wiring)
- [x] Использует существующий `validateManifestShape` для diagnose
- [x] Pure-planner `repairManifestPlanner.planRepairManifest` — пересборка из cloudFilePaths + machines
- [x] `describeRepairPlan` — confirmation copy с N файлов / K машин
- [ ] Activity log событие `manifest_repaired` (deferred)
- [x] Unit-тесты на pure-planner (`tests/unit/repairManifestPlanner.test.ts`)

## 14.4 Pending op re-queue после auth expiry (F-004)

- [ ] В `_runWithEngine` catch `UNAUTHORIZED` → stash pending op (kind + args) в `syncOfflineQueueStore`
- [ ] Новый тип очереди `auth_blocked_op` с TTL 24h
- [ ] После успешного reauth (`onProviderTokensChanged`) — drain auth-blocked queue
- [ ] UI hint: «У вас X операций ожидает повторной авторизации»
- [ ] Юнит-тесты на planner

## 14.5 Workspace-removed-on-cloud — actionable prompt (F-005)

- [x] `onRemoteWorkspaceDeleted` показывает `showWarningMessage` с кнопками
- [x] Кнопки: «Залить на облако», «Открыть Activity Feed» (auto-detach уже работает в engine)
- [x] Dedup через `warnedRemoteDeletedKeys` (уже было)
- [ ] Сохранить detection в `activity.json` с kind `workspace_remote_deleted` (deferred — нужен новый ActivityKind)

## 14.6 Post-download integrity check (F-006)

- [ ] Все провайдеры: после download проверять SHA-256 plaintext canon vs `_meta.hash`
- [ ] При несовпадении → `ProviderError("INTEGRITY_FAILED")`, retry 3 раза, потом surfact как warning
- [ ] Setting `vscodesync.safety.postDownloadIntegrity` (default `true`)
- [ ] Unit-тесты с corrupt-stream mock provider

## 14.7 listFolder pagination (F-007)

- [x] OneDrive `listFolder`: цикл по `@odata.nextLink`
- [x] GDrive `listFolder`: цикл по `nextPageToken`
- [x] Yandex `listFolder`: цикл по `offset` (limit=1000)
- [x] Dropbox уже paginates (cursor) — sanity-check OK
- [x] Hard cap 50_000 от runaway (constant, не настройка)
- [ ] Contract test: workspace c >1200 файлами → все попадают в результат (deferred — нужен mock провайдер с pagination)

## 14.8 Take-ownership notification на проигравшее окно (F-008)

- [x] При `forceAcquireWorkspaceInstanceLock` записать `.took-ownership-by` (PID + winnerLabel + atIso)
- [x] `consumeTookOwnershipMarker` для read+delete (single-shot, dedup)
- [x] `createWorkspaceInstanceLockRefresher` проверяет marker на каждом refresh + показывает toast
- [x] Toast: «Это окно стало Read-only — основное окно VSCode (PID N, label X) взяло владение» + кнопка Take Sync Ownership
- [ ] Unit-тесты на marker read/write/dedup (deferred — нужен fs-mock fixture)

## 14.9 Keep-both для конфликтов (F-009)

- [x] Engine method `SyncEngine.resolveConflictKeepBoth(wsId, posixRel)`
- [x] Pure planner `planKeepBothResolution` — суффикс с `.conflict-<machine>-<ts>` перед расширением
- [x] Бэкап локального в `.vscode/vscodesync-local-backup/conflict-<ts>/<rel>` (engine path)
- [x] Cloud blob продолжает жить под старым именем; локальная "theirs"-версия с суффиксом для review
- [x] Binary-safe (writeFile с raw Buffer)
- [x] Activity log событие `resolve_keep_mine` с meta `{rule: "keep-both", theirsRel: ...}`
- [x] Unit-тесты на planKeepBothResolution (`tests/unit/keepBothConflictResolver.test.ts`)
- [ ] UI: добавить кнопку в `registerConflictsCommands` quick pick + в file decorations menu (deferred — UI wiring)
