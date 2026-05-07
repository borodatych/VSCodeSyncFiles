# Фаза 4: Reliability

> **Цель:** расширение работает надёжно в реальных условиях: автотриггеры, оффлайн, гонки, rate limits, параллельные окна. После этой фазы: можно доверять расширению в ежедневной работе.

**Зависимости:** [03-ui](../03-ui/roadmap.md) ✅  
**Следующая фаза:** [05-providers](../05-providers/roadmap.md)

---

## Модули этой фазы

| Модуль | Файл | Статус |
|--------|------|--------|
| Оффлайн, concurrency, rate limits | [offline-concurrency.md](offline-concurrency.md) | `[~]` *(RequestQueue / прочее — в спеке)* |

---

## 4.1 Триггеры синхронизации

| Событие | Действие |
|---------|----------|
| Старт VSCode / открытие workspace | Полный цикл (манифест → файлы) для всех активных workspace'ов |
| Фокус окна VSCode | Тихий полный цикл с задержкой `syncOnFocusDelayMs` |
| Сохранение файла (`onSave`) | Push с debounce `saveDebounceSec` (глобально 3с, per-workspace настраивается) |
| Открытие файла (`onOpen`) | Pull если удалённый файл новее |
| Git commit (`onDidCommit`) | Push закоммиченных файлов если `pushOnCommit: true` |
| Ручная команда | Полный цикл для выбранного workspace или всех |

- [x] Реализовать `TriggerManager` — подписка на VSCode события (`src/ui/syncTriggerManager.ts`)
- [x] `onSave` debounce: использовать `saveDebounceSec` из `activeWorkspaces` (per-workspace override; иначе 3 с)
- [x] `onFocus`: тихий полный цикл по всем workspace папкам после задержки, если окно всё ещё в фокусе (`syncOnFocusDelayMs`)
- [x] `onOpen`: только если `vscodesync.syncOnOpen: true` (умолчание true)
- [x] Git commit интеграция через `vscode.extensions.getExtension('vscode.git')` + `git diff-tree` (tracked в пределах repo/folder)
- [x] Unit-тесты: разбор debounce и путей (`tests/unit/syncTriggerLogic.test.ts`)

---

## 4.2 Пауза глобальная (`VSCodeSync: Pause` / `Resume`)

- [x] Глобальный флаг `paused: boolean` в runtime-состоянии (`syncSessionPause`, не в конфиге; legacy `syncPaused` в JSON мигрируется при старте)
- [x] При `Pause`: отключить `onSave` push и `onFocus` pull (и onOpen / Git push-on-commit)
- [x] Ручные команды Push/Pull работают и во время паузы (`runWithEngine` без блокировки)
- [x] При `Resume`: Preview изменений накопившихся за время паузы → опциональная полная синхронизация (`runAfterSessionResume`)
- [x] Статус-бар: `⏸` + счётчик `pending` для сохранений отслеживаемых файлов на паузе
- [x] Watch Mode при паузе: `registerWatchModePoller` не вызывает sync, пока включена session pause; интервал `watchIntervalSeconds`

---

## 4.3 Suspend/Freeze workspace

- [x] **Suspend** — Push/Pull файлов отключены, манифест продолжает обновляться; `lastSeen` через операции манифеста (rename/tags/branch); `syncState: suspended` в vscodesync.json
- [x] **Freeze** — Push/Pull файлов и PUT манифеста отключены; `syncState: frozen`
- [x] При Unfreeze: Pull манифеста + полный sync (накопившиеся изменения)
- [x] Хранить состояние в `activeWorkspaces[].syncState: 'active' | 'suspended' | 'frozen'` *(в JSON поле опущено = активен)*

---

## 4.4 FileLock (per-file блокировка)

- [x] `FileLock` — очередь промисов на каждый путь (`src/core/syncFileLock.ts`, `runWithSyncFileLock`)
- [x] Pull и onSave Push для одного пути выполняются последовательно (обёртка в `SyncEngine.pushFile` / `pullFile`)
- [x] Debounce onSave сбрасывается при входе в Pull по пути (`subscribeSyncFileLock` в `syncTriggerManager`)
- [x] Unit-тест: параллельный Pull + Push → FIFO (`tests/unit/syncFileLock.test.ts`)

---

## 4.5 Расписание синхронизации

- [x] Конфиг `vscodesync.syncSchedule`:
  ```json
  { "enabled": false, "activeHours": "09:00-18:00", "activeDays": ["Mon",...], "timezone": "auto" }
  ```
  — см. `package.json`, логика в `src/core/syncSchedule.ts`, UI gate `src/ui/syncScheduleGate.ts`
- [x] Вне расписания: автотриггеры отключены, ручные команды работают (`runWithEngine` / палитра без `bypassSchedule`; авто-тихие пути через gate)
- [x] Изменения накапливаются в персистентной очереди **`schedule-deferred.json`** (`SyncScheduleDeferredStore`); flush при входе в активный период (`syncScheduleTransition.ts`)
- [x] При входе в активный период: flush очереди + уведомление; ручные команды доступны в любое время
- [x] Статус-бар: индикатор scheduled pause + счётчик queued deferred (`SyncStatusBarController`)
- [x] `"timezone": "auto"` → `Intl.DateTimeFormat().resolvedOptions().timeZone`

---

## 4.6 Авто-пауза (metered/battery)

- [x] `pauseOnMeteredConnection: true`: определять через `navigator.connection.metered` (`readNavigatorMetered`); если API недоступен — пауза по metered **не** включается
- [x] `pauseBatteryThreshold: 15`: чтение заряда ОС (`readBatteryPercent` — Windows PowerShell CIM / macOS `pmset` / Linux sysfs); `0` — отключено
- [x] При авто-паузе: автотриггеры отключены (`syncAutoPause` + проверки в `syncTriggerManager`, `quietFullSyncAllFolders`, watch); ручные команды через `runWithEngine` не затронуты
- [x] Авто-снятие при восстановлении условий (опрос `registerAutoPauseMonitor`, интервал 30 с + при смене настроек)
- [x] Не влияет на Quick Transfer и ручные команды

---

## 4.7 Параллельные окна VSCode (lock-файл)

- [x] Lock-файл: `~/.vscode/vscodeSync/{workspaceRootHash}.lock`
  ```json
  { "pid": 12345, "nonce": "f3a1b2c4-...", "lockedAt": "2026-04-28T14:32:00Z" }
  ```
- [x] При старте: создать lock (PID + nonce)
- [x] Второй экземпляр: обнаружить lock → проверить PID + `lockedAt` / время создания процесса (Windows)
- [x] Stale lock (PID мёртв): удалить, взять управление
- [x] Второй экземпляр с живым lock: read-only режим (Pull + завершение pull через `_meta`, Push/манифест — нет)
- [x] Статус-бар: read-only (sync в другом окне)
- [x] При закрытии VSCode: удалить lock (`deactivate` + смена workspace)
- [x] Windows PID reuse: `Get-CimInstance Win32_Process` CreationDate vs `lockedAt`

---

## Критерий готовности фазы

- [x] Автотриггеры работают (onSave debounce, onFocus с задержкой)
- [x] Оффлайн-режим (MVP): автосинк кладёт операции в `queue.json`, recovery-monitor flush при сети + backoff
- [x] Rate limit: backoff + Retry-After (OneDrive 429/503), статус-бар и пауза автосинка
- [x] FileLock: нет гонок между Pull и onSave Push
- [x] Lock-файл: второй экземпляр VSCode в read-only
- [x] Все тесты проходят
