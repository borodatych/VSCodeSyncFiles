# Разрешение конфликтов

> Конфликт = оба файла изменились с момента последней синхронизации (`localHash ≠ _meta.hash` AND `cloudHash ≠ _meta.hash`).

**Часть фазы:** [02-core-sync](roadmap.md)

---

## 3-way diff

- [x] `vscodesync.openConflictDiff3way` — скачивает последнюю версию из `.history/` как `base` + текущую облачную версию; открывает 2 diff'а:
  - `base ← → local` «ваши изменения (история → локально)»
  - `base ← → remote` «облачные изменения (история → облако)» в боковой колонке
- [x] Fallback: если история недоступна → 2-way diff `local ↔ cloud` с уведомлением
- [x] Команда "Open Diff" в `resolveConflicts` вызывает `runConflict3WayDiff` (3-way → 2-way fallback)
- [x] После разрешения: итоговая версия пушится на облако (`resolveConflictKeepMine`/`TakeTheirs` → push)
- [x] `_meta.json` обновляется новым hash/version (в pushFile)

---

## Отложенный конфликт

- [x] Файл помечается `⚠ Conflict` в `vscodesync.json` (`syncStatus = "conflict"` в `TrackedFile`)
- [x] Push/Pull **только этого файла** блокируется до разрешения (проверка в `pushFile` / `pullFile`)
- [x] Остальные файлы workspace'а продолжают синхронизироваться
- [x] Синхронизация снимается только после явного разрешения (`resolveConflictKeepMine` / `resolveConflictTakeTheirs`)

---

## Multi-conflict queue

- [x] Несколько файлов в конфликте → `showWarningMessage` с выбором batch-режима:
  - **Keep Mine All** / **Take Theirs All** — пакетное разрешение всех через `engine.resolveConflictKeepMine`/`TakeTheirs` в цикле
  - **Разрешить по одному** — последовательная очередь: `⚠ Конфликт 1/N: path → [Keep Mine] [Take Theirs] [Open Diff] [Skip]`
- [x] После разрешения текущего → автоматически следующий
- [x] `[Open Diff]` → вызывает `vscodesync.diffWithCloud`, затем повторно показывает диалог для того же файла

---

## Keep Mine / Take Theirs (без diff)

- [x] `engine.resolveConflictKeepMine(workspaceId, posixRel)` — пушит локальный файл, снимает конфликт
- [x] `engine.resolveConflictTakeTheirs(workspaceId, posixRel)` — тянет облачный файл, снимает конфликт
- [x] `vscodesync.keepMine` — palette/context команда (из активного редактора); проверяет `syncStatus === "conflict"` перед вызовом движка
- [x] `vscodesync.takeTheirs` — palette/context команда (аналогично)
- [x] Доступны только для файлов в статусе `⚠ Conflict` (guard в обоих методах)

---

## Конфликт бинарного файла

- [x] `engine.onNewConflict(workspaceId, workspaceNote, relPath, isBinary)` — колбэк в `SyncEngineDeps`; вызывается из `syncOneFile` и `pushFile` при `PRECONDITION_FAILED`
- [x] Обнаружение бинарного файла: `fileLooksBinary(abs)` — проверка нулевых байт (эвристика)
- [x] При `isBinary=true`: уведомление выделяет что файл бинарный; кнопка «Resolve Now» → `resolveConflicts`
- [x] Dedupe по `workspaceId:relPath` через `notifiedConflictKeys` (session-level Set) — одно уведомление на конфликт

---

## Первый Pull при существующем локальном файле

- [x] Если локальный файл существует — локальный бэкап → pull (без блокирующего диалога; полноценный diff-диалог — UI-фаза)
- [x] Если локального файла нет → создать без диалога (Pull as new file)

---

## Watch Mode + конфликт

- [x] При обнаружении конфликта: `onNewConflict` колбэк → `showWarningMessage` один раз на конфликт (`notifiedConflictKeys` dedupe)
- [x] Файл исключается из polling до разрешения (проверка `syncStatus === "conflict"` в `syncOneFile`)
- [x] Watch Mode продолжает работать для остальных файлов

---

## AI Merge (опционально, opt-in)

- [x] `vscodesync.aiMerge: true` (умолч. false) — в `package.json`
- [x] `src/core/aiMerge.ts`: `runAiMerge(base, local, remote, relPath)` через VS Code LM API (`vscode.lm.selectChatModels`); модель — Copilot gpt-4o; fallback на любую доступную; результат обёрнут в `<merged>...</merged>` тегах; возвращает `AiMergeResult`
- [x] `isAiMergeAvailable()` — для условного показа кнопки в UI
- [x] Кнопка **✨ Merge with AI** в диалоге `resolveConflicts` (single-file очередь): `runAiMergeForConflict` в `extension.ts` — скачивает remote + base из `.history/`, читает local, вызывает `runAiMerge`, при успехе записывает merged и пушит через `keepMine`; при ошибке — возврат в ручной диалог

---

## Правила авторазрешения (`conflictRules`)

- [x] `ConflictRule` тип: `{ pattern: string; strategy: 'keep-mine' | 'take-theirs' | 'newer' }` — в `src/core/types.ts`
- [x] `conflictRules?: ConflictRule[]` в `SyncEngineDeps` (передаётся из extension settings)
- [x] Пример конфига:
  ```json
  "vscodesync.conflictRules": [
    { "pattern": "*.lock",            "strategy": "keep-mine"   },
    { "pattern": "package-lock.json", "strategy": "keep-mine"   },
    { "pattern": "config/shared/**",  "strategy": "take-theirs" }
  ]
  ```
- [x] Стратегии: `keep-mine`, `take-theirs`, `newer` (newer сравнивает mtime vs `_meta.updatedAt`)
- [x] Glob-матчинг: `*` в пределах сегмента, `**` на любую глубину (`minimatchGlob` в `syncEngine.ts`)
- [x] Проверяются до показа конфликта пользователю (в `syncOneFile`, после LineEnding auto-resolve)
- [x] Первое совпадающее правило побеждает
- [x] При авторазрешении: запись в Activity Feed (`resolve_keep_mine` / `resolve_take_theirs` с `meta.autoResolved=true`)
- [x] Unit-тесты: `tests/unit/conflictResolution.test.ts` — все 3 стратегии, приоритет, no-match

---

## Локальный бэкап перед перезаписью

- [x] Перед любым Pull перезаписывающим файл: сохранить текущую версию в:
  ```
  .vscode/vscodesync-local-backup/{ISO-timestamp}/{path}
  ```
- [x] `vscodesync.localBackupEnabled: true` (умолчание; `localBackupEnabled !== false` в engine)
- [x] `vscodesync.localBackupRetentionDays: 7` (в `backupLocalWithPrune` → `pruneLocalBackups`)
- [x] Показывать в `Show File History` как `📁 local backup` — `runShowFileHistory` сканирует `.vscode/vscodesync-local-backup/` для данного файла и добавляет в quick-pick
