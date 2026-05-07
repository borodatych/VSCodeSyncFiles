# Управление Workspace'ами

> Создание, подключение, отвязка, удаление workspace'ов. Всё что связано с жизненным циклом workspace'а.

**Часть фазы:** [02-core-sync](roadmap.md)  
**Связанный файл:** [manifest-protocol.md](manifest-protocol.md)

---

## Создание workspace (`VSCodeSync: Create Workspace`)

- [x] `engine.createWorkspace(note, providerType)` — генерирует workspaceId (8 hex), создаёт манифест + `_meta.json` на облаке, добавляет в `activeWorkspaces`
- [x] Input box для `workspaceNote` в Palette (UI-слой)
- [x] Quick-pick шаблонов начального набора файлов после создания (`.env`, `config/`, `scripts/`, `src/`, `**`, без файлов) — `findFiles` по glob + batch `addFiles`; защита по `batchAddWarnThreshold`
- [x] Предупреждение при дублирующемся `workspaceNote` (UI-слой; `listRemoteWorkspaceSummaries` уже доступен)

---

## Подключение к существующему (`VSCodeSync: Connect to Cloud Workspace`)

- [x] `engine.listRemoteWorkspaceSummaries()` — сканирует `VSCodeSyncFiles/`, возвращает `[{ workspaceId, workspaceNote }]`
- [x] `engine.attachCloudWorkspace(workspaceId)` — проверяет schemaVersion, регистрирует машину, добавляет в `activeWorkspaces`, тянет файлы
- [x] Quick-pick с мультиселектом в Palette (UI-слой; `canPickMany: true`)
- [x] Dry-run preview перед подключением (UI-слой; `previewSyncPlan` готов)
- [x] Проверка пересечений путей при подключении: `engine.listCloudWorkspaceFiles(workspaceId)` → сравнение с уже трекаемыми файлами → предупреждение с modal-диалогом до `attachCloudWorkspace`
- [x] Предупреждение при несовпадении `providerType` (UI-слой)

---

## Добавление файлов в трекинг

- [x] `engine.addFiles(workspaceId, absolutePaths)` — batch push, обновляет манифест + `_meta` + `vscodesync.json`
- [x] `hasSyncignoreMarkers` выставляется при add (`fileHasSyncMarkers`)
- [x] `maxFileSizeMB` лимит проверяется (`assertFileWithinSizeLimit`)
- [x] Multi-select в Explorer: `addCurrentFile(uri, allUris)` — при множественном выделении VS Code передаёт `allUris[]`; все файлы добавляются в один выбранный workspace за один вызов `addFiles`

---

## Удаление из трекинга (`Remove from Sync`)

- [x] `engine.removeTrackedFiles(workspaceId, absolutePaths)` — удаляет blob, ставит tombstone `removedAt` в манифесте, убирает из `vscodesync.json`
- [x] `engine.untrackFileLocal(workspaceId, absolutePaths)` — убирает только из локального `vscodesync.json`, облако нетронуто
- [x] `engine.untrackFileTombstoneOnly(workspaceId, absolutePaths)` — tombstone в манифесте (все машины перестают трекить), blob не удаляется
- [x] Диалог выбора (удалить с облака / только отвязать / убрать у всех машин) — UI-слой

---

## Перемещение файла между workspace'ами (`Move to Workspace`)

- [x] `engine.mergeWorkspaces(sourceId, targetId)` — перенос файлов + слияние манифестов
- [x] Drag-and-drop в боковой панели: `WorkspacesTreeDnD` (`src/ui/workspacesTreeDnD.ts`) — перетаскивание файлов между workspace'ами с modal-подтверждением

---

## Detach workspace (`VSCodeSync: Detach Workspace...`)

- [x] `engine.detachWorkspaceLocal(workspaceId)` — убирает из `activeWorkspaces`, файлы на облаке нетронуты

---

## Удаление workspace с облака (`Delete from Cloud`)

- [x] `engine.deleteWorkspaceFromCloud(workspaceId)` — рекурсивно удаляет `VSCodeSyncFiles/{workspaceId}/`, затем detach
- [x] Диалог о судьбе локальных файлов (UI-слой; два варианта: оставить / удалить локально)

---

## Переименование (`VSCodeSync: Rename Workspace Note`)

- [x] `engine.renameWorkspaceNote(workspaceId, newNote)` — обновляет манифест на облаке + локальный кэш
- [x] Другие машины получают новое название при следующем pull манифеста

---

## Отслеживание файловых событий

- [x] `onDidDeleteFiles`: диалог `"Убрать из синхронизации?"` / `"Восстановить файл"` (extension.ts)
- [x] `onDidRenameFiles`: обновить `localPath`, `cloudPath`; записать `renamedFrom`/`renamedAt` в манифест (engine + extension.ts); при перемещении за пределы workspace — `untrackFileLocal`
- [x] `engine.renameTrackedFile(workspaceId, oldAbs, newAbs)` — копирует blob, ставит tombstone старого, добавляет новый манифест с renamedFrom/renamedAt
- [x] При pull манифеста: обнаружить `renamedFrom` → обновить локальный путь, не создавать дубликат (`adoptManifestFilesFromCloud`)

---

## Repair State (`VSCodeSync: Repair State`)

- [x] `engine.repairLocalStateFromCloud(workspaceId?)` — скачивает свежие манифесты, пересобирает кэш ETag + workspaceNote в `vscodesync.json`
- [x] Режим сканирования при повреждённом манифесте: `engine.repairByCloudScan(workspaceId)` — `listFolder` папки workspace, фильтрация blob-файлов, реконструкция `_meta.json`; UI: команда `repairState` → quick-pick режима (обычный / полный скан) → опция Pull после сканирования

---

## Tombstone-очистка

- [x] `purgeTombstones(manifest)` в `syncEngine.ts` — при каждом `putManifest` удаляет записи с `removedAt` старше `tombstonePurgeDays` (умолч. 30)
- [x] Очищает `renamedFrom`/`renamedAt` у записей с `renamedAt` старше `tombstonePurgeDays`
- [x] Unit-тест: `tests/unit/conflictResolution.test.ts` — tombstone purge + recent retained
- [x] Кейс "офлайн > 30 дней + удалённый файл" → warning-диалог с Output channel (engine callback `onPurgeLostFiles` + dedupe в UI-слое)
