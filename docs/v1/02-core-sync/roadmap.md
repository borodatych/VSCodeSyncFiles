# Фаза 2: Core Sync

> **Цель:** полный цикл синхронизации через OneDrive. После этой фазы: можно создать workspace, добавить файлы, push/pull, видеть конфликты и разрешать их. Без fancy UI — только работающая логика.

**Зависимости:** [01-foundation](../01-foundation/roadmap.md) ✅  
**Следующая фаза:** [03-ui](../03-ui/roadmap.md)

---

## Модули этой фазы

| Модуль | Файл | Статус |
|--------|------|--------|
| OneDrive провайдер | [onedrive.md](../05-providers/onedrive.md) | `[~]` Graph + device code; refresh/крупные файлы — позже |
| Управление workspace'ами | [workspace-management.md](workspace-management.md) | `[~]` create + add file в Palette; connect/dry-run — позже |
| Протокол манифеста | [manifest-protocol.md](manifest-protocol.md) | `[~]` merge + ETag + `schemaVersion` 1; read-only при новой схеме — позже |
| Разрешение конфликтов | [conflict-resolution.md](conflict-resolution.md) | `[~]` флаг conflict + Keep Mine; diff/очередь — фаза UI |

---

## 2.1 Движок синхронизации (SyncEngine)

- [x] Реализовать `SyncEngine` — центральный оркестратор:
  - `syncWorkspace(workspaceId)` — полный цикл (манифест → файлы)
  - `pushFile(localPath, workspaceId)` — залить один файл
  - `pullFile(localPath, workspaceId)` — скачать один файл
  - `pushAll(workspaceId?)` — залить все файлы (опционально по workspace)
  - `pullAll(workspaceId?)` — скачать все файлы
- [x] Manifest-first порядок: всегда `pull manifest → diff → pull/push files`
- [x] Применить canonical pipeline (`CanonicalPipeline` из Foundation)
- [x] Integration-тесты с mock-провайдером (`tests/unit/syncEngine.test.ts`)

---

## 2.2 Определение изменений (Change Detection)

- [x] Сравнение `localHash` (из `vscodesync.json`) с актуальным хэшем файла → pending push
- [x] Получение `cloudHash` из `_meta.json` провайдера
- [x] 3-way logic:
  - `localHash == cloudHash` → no change
  - `localHash != _meta.hash` AND `cloudHash == _meta.hash` → local newer, push
  - `localHash == _meta.hash` AND `cloudHash != _meta.hash` → remote newer, pull
  - both changed → conflict
- [x] `_meta.json` структура:
  ```json
  { "files": { "src/auth/login.ts": { "hash": "...", "machineId": "...", "updatedAt": "...", "etag": "...", "version": 7 } } }
  ```
- [x] Unit-тесты для всех 4 кейсов (`tests/unit/changeDetection.test.ts`)

---

## 2.3 Push файла

- [x] Прочитать файл → применить normalize + sanitize → вычислить hash
- [x] Загрузить на облако с `If-Match: <etag>` если etag известен
- [x] При `412 Precondition Failed` → пометка `conflict` + `onNewConflict` callback (уведомление + предложение разрешить); merge-диалог через `resolveConflicts` (3-way diff, Keep Mine, Take Theirs)
- [x] Верификация после upload: GET метаданных → сравнить hash → retry ×3 при несовпадении
- [x] Обновить `_meta.json` (с ETag для самого `_meta.json`)
- [x] Обновить `localHash` и `lastSync` в `vscodesync.json`
- [x] Записать версию в `.history/` (до 10 версий)

---

## 2.4 Pull файла

- [x] Conditional GET: `If-None-Match: <etag>` → skip если `304 Not Modified`
- [x] При существующем локальном файле с другим хэшем → backup + pull (без диалога при первом pull); при конфликте двух изменений — `onNewConflict` уведомление + `resolveConflicts` с 3-way diff
- [x] При отсутствии локального файла → создать директории + записать (без диалога)
- [x] Сохранить локальный бэкап в `.vscode/vscodesync-local-backup/` перед перезаписью
- [x] Merge syncignore-блоков: локальное содержимое блоков сохраняется при pull
- [x] Пересчитать hash после merge syncignore → сохранить в `localHash`
- [x] Обновить `lastSync` в `vscodesync.json`

---

## 2.5 Полный цикл (Sync All)

- [x] Для каждого активного workspace:
  1. Pull `.vscodesync-workspace.json` (Conditional GET с ETag)
  2. Diff cloud-манифест vs локальный:
     - [x] Файл удалён в манифесте → убрать из локального трекинга (`pruneTrackingFromManifest`)
     - [x] Файл добавлен в манифесте → `adoptManifestFilesFromCloud` (вызывается в `syncWorkspace` ПЕРЕД pruning, с поддержкой `renamedFrom`)
  3. Сохранить обновлённый `vscodesync.json`
  4. Синхронизировать файлы (pull новее, push изменённые)
- [x] Integration-тест: полный цикл с двумя "машинами" через mock (`tests/unit/syncEngine.test.ts`)
- [x] Unit-тест: `onPurgeLostFiles` callback, `renamedFrom` detection, `onNewConflict` callback (`tests/unit/engineCallbacks.test.ts`)

---

## Критерий готовности фазы

- [x] Можно создать workspace, добавить файл, push/pull через команды в Command Palette
- [x] Conflict detection работает корректно (unit + mock integration; две машины — `syncEngine.test.ts`)
- [x] ETag concurrency control работает (mock + OneDrive API)
- [x] Все тесты проходят
