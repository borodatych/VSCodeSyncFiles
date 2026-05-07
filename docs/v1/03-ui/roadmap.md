# Фаза 3: UI

> **Цель:** полноценный пользовательский интерфейс. После этой фазы: расширение удобно использовать через боковую панель, статус-бар, контекстное меню и онбординг-мастер.

**Зависимости:** [02-core-sync](../02-core-sync/roadmap.md) ✅  
**Следующая фаза:** [04-reliability](../04-reliability/roadmap.md)

---

## Модули этой фазы

| Модуль | Файл | Статус |
|--------|------|--------|
| Боковая панель | [side-panel.md](side-panel.md) | `[~]` TreeView + DnD + секция **неподключённых workspace на облаке** |
| Онбординг мастер | [onboarding.md](onboarding.md) | `[~]` MVP первый запуск + Start Onboarding Wizard; шаг 3 — connect к облаку |

---

## 3.1 Статус-бар

- [x] Постоянный индикатор в нижней панели (`SyncStatusBarController`, формат: провайдер · ws/files · last sync)
- [~] Состояния: Idle ✓ · Syncing ✓ · `⚠ N conflicts` ✓ · **Pause** ✓ (session `syncSessionPause`, не `config.json`; счётчик pending в статус-баре) · остальное (`Offline`, авто‑пауза по сети/батарее, Rate limited, Read-only…) — фаза Reliability / позже
- [x] При конфликтах: счётчик в строке + разбивка по workspace в tooltip (`SyncStatusBarController.buildTooltip`)
- [x] Клик по статус-бару → открыть панель Workspaces (`focusWorkspacesView`); текстовая сводка — команда `Show Sync Dashboard`
- [x] ПКМ статус-бара → `Set Notification Level` (настройка `vscodesync.notificationLevel`)
- [x] Badge на view «Workspaces» в Activity Bar (`TreeView.badge` — число конфликтов)

---

## 3.2 Контекстное меню (ПКМ в Explorer + вкладка редактора)

- [x] **Add to Sync** — добавить файл (`Add Current File` + URI из контекста)
- [x] **Remove from Sync** — убрать с подтверждением + удаление с облака (`removeTrackedFiles` в движке)
- [x] **Move to Workspace** — `moveCurrentFileToWorkspace` (remove из старого WS → add в новый)
- [x] **Push Now** — `Push Current File`
- [x] **Pull Now** — `Pull Current File`
- [x] **Show Sync History** — облачная `.history/` (QuickPick → открыть / diff с локальным); дерево Workspaces
- [x] **Send to Other Machine (one-time)** — Quick Transfer из Explorer/редактора и **из дерева Workspaces** (`resolveFileTargetLoose` в `sendQuickTransfer`)
- [x] **Keep Mine** *(только `⚠ Conflict`)* — в редакторе + древо; Explorer — команда с проверкой
- [x] **Take Theirs** *(только `⚠ Conflict`)* — `resolveTakeTheirs` / `treeFileTakeTheirs`
- [x] **Open in Cloud Storage** — OneDrive: `webUrl` из Graph; mock/прочие — сообщение «не поддерживается»
- [x] **Diff with Cloud** — `vscode.diff` локально ↔ временный файл из облака
- [~] Команды скрыты если файл не в трекинге (`when` context) — **редактор:** `vscodeSync.activeFileTracked` / `activeFileConflict`; **Explorer:** без per-resource контекста, команды валидируют сами

---

## 3.3 Command Palette (полный список команд)

- [x] Зарегистрировать все команды в `package.json` `contributes.commands` — полный список §3.3; часть команд пока **заглушки** (`src/ui/plannedPaletteCommands.ts`) или только смена настройки (`watchMode`)


**Уже с логикой (не заглушка):** Repair State, **Preview Sync** (dry-run плана по файлам → Output «VSCodeSync · Preview»), Export/Import Workspace Structure, Pause/Resume, Open Stats/Activity, Edit Ignore, Git branch/Tags, Health, watchMode, Suspend/Freeze/Resume/Unfreeze workspace, **Delete Workspace from Cloud**, **startup Pull + Sync Summary** (`syncSummaryOnStartup`).
```
VSCodeSync: Add Current File
VSCodeSync: Remove from Sync
VSCodeSync: Move Current File to Workspace
VSCodeSync: Send File (One-time Transfer)
VSCodeSync: Push All
VSCodeSync: Pull All
VSCodeSync: Push Current File
VSCodeSync: Pull Current File
VSCodeSync: Push Workspace...
VSCodeSync: Pull Workspace...
VSCodeSync: Preview Sync...
VSCodeSync: Resolve Conflicts
VSCodeSync: Open Settings
VSCodeSync: Switch Provider
VSCodeSync: Show File History
VSCodeSync: Show Sync Summary
VSCodeSync: Create Workspace
VSCodeSync: Connect to Cloud Workspace
VSCodeSync: Detach Workspace...
VSCodeSync: Delete Workspace from Cloud...
VSCodeSync: Rename Workspace Note
VSCodeSync: Enable Watch Mode
VSCodeSync: Disable Watch Mode
VSCodeSync: Pause
VSCodeSync: Resume
VSCodeSync: Export Workspace Structure
VSCodeSync: Import Workspace Structure
VSCodeSync: Open Stats
VSCodeSync: Create Snapshot
VSCodeSync: Restore Snapshot...
VSCodeSync: Migrate to Another Provider
VSCodeSync: Repair State
VSCodeSync: Suspend Workspace...
VSCodeSync: Resume Workspace...
VSCodeSync: Freeze Workspace...
VSCodeSync: Unfreeze Workspace...
VSCodeSync: Open Activity Feed
VSCodeSync: Set Notification Level
VSCodeSync: Configure Path Mapping
VSCodeSync: Edit Workspace Ignore Patterns
VSCodeSync: Export Encryption Key
VSCodeSync: Import Encryption Key
VSCodeSync: Rotate Encryption Key
VSCodeSync: Archive Workspace...
VSCodeSync: Diff with Cloud
VSCodeSync: Set Git Branch for Workspace...
VSCodeSync: Edit Workspace Tags
VSCodeSync: Purge Encrypted Workspace...
VSCodeSync: Health Check
VSCodeSync: Merge Workspaces
VSCodeSync: Toggle Telemetry
```

---

## 3.4 File Decorations (Explorer)

- [x] Зарегистрировать `FileDecorationProvider` (`SyncFileDecorationController`)
- [x] Иконки статуса:
  - [x] `↑` локально изменён относительно последнего sync / `pending_push`
  - [x] `✓` synced (хэш совпадает с `localHash`)
  - [x] `⚠` conflict
  - [x] `🔄` при глобальной синхронизации (push/pull)
  - *(без иконки)* не в трекинге
- [x] Цвета через `ThemeColor` (gitDecoration.*)
- [x] `vscodesync.showFileDecorations: true` (умолчание)
- [x] Обновление: `onDidChangeFileDecorations` после sync, смены конфига, сохранения `vscodesync.json`

---

## 3.5 Keyboard Shortcuts

- [x] Зарегистрировать команды в `contributes.keybindings` (без дефолтных клавиш): набор в `package.json` включает push/pull workspace, quick transfer, connect, resolve, settings, телеметрию, pause/watch/activity и базовые push/pull
  ```json
  [
    { "command": "vscodesync.pushCurrentFile" },
    { "command": "vscodesync.pullCurrentFile" },
    { "command": "vscodesync.pushAll" },
    { "command": "vscodesync.pullAll" },
    { "command": "vscodesync.showFileHistory" },
    { "command": "vscodesync.togglePause" },
    { "command": "vscodesync.toggleWatchMode" },
    { "command": "vscodesync.resolveConflicts" },
    { "command": "vscodesync.openActivityFeed" }
  ]
  ```
- [x] Рекомендуемые биндинги показывать в онбординге (текст + кнопка «Открыть Keyboard Shortcuts», см. `onboarding.ts`)

---

## 3.6 Settings UI

- [~] Зарегистрировать все настройки в `contributes.configuration`: ключи объявлены в `package.json`; проводка в движок/UI — по мере фаз Reliability / Power Features
  - [x] `vscodesync.maxFileSizeMB` (number, 5) — лимит в `SyncEngine` + `0` = без лимита
  - [x] `vscodesync.warnOnBinaryFiles` (boolean, true) — диалог перед add/push single
  - [x] `vscodesync.showPreview` (boolean, true) — подтверждение перед **Add Current File** и перед Pull/Push/Sync workspace из дерева Workspaces (план → Output + модальное окно)
  - [x] `vscodesync.syncSummaryOnStartup` (boolean, true) — после запуска VS Code: Pull для папок с активными workspace и уведомление-сводка при отличиях кэша до/после pull (`syncSummaryStartup.ts`)
  - [x] `vscodesync.showFileDecorations` (boolean, true)
  - [x] `vscodesync.notificationLevel` (enum: minimal/normal/verbose)
  - [x] `vscodesync.compressUploads` (boolean, false)
  - [x] `vscodesync.lineEnding` (enum: lf/crlf/preserve, "lf") — хэш и канон в `SyncEngine`, декорации Explorer (`fileDecorations.ts`)
  - [x] `vscodesync.localBackupEnabled` (boolean, true) — перед перезаписью при pull (`SyncEngine.pullFile`)
  - [x] `vscodesync.localBackupRetentionDays` (number, 7) — очистка старых каталогов в `.vscode/vscodesync-local-backup/` по mtime; `0` — не удалять
  - [x] `vscodesync.fileEncoding` (string, "utf8")
  - [x] `vscodesync.batchAddWarnThreshold` (number, 50)
  - [x] `vscodesync.pushOnCommit` (boolean, false)
  - [x] `vscodesync.conflictRules` (array)
  - [x] `vscodesync.snapshotRetentionDays` (number, 180)
  - [x] `vscodesync.maxSnapshotsPerWorkspace` (number, 20)
  - [x] `vscodesync.workspaceInactiveDays` (number, 90)
  - [x] `vscodesync.longAbsenceThresholdDays` (number, 3)
  - [x] `vscodesync.monthlyBandwidthLimitMB` (number, 0)
  - [x] `vscodesync.syncOnFocusDelayMs` (number, 3000)
  - [x] `vscodesync.syncOnOpen` (boolean, true) — pull при открытии файла (`syncTriggerManager`)
  - [x] `vscodesync.smartSuggestions` (boolean, true)
  - [x] `vscodesync.digestIntervalMinutes` (number, 30)
  - [x] `vscodesync.quickTransferTtlDays` (number, 7) — TTL пакета Quick Transfer на облаке
  - [x] `vscodesync.requireMachineApproval` (boolean, false)
  - [x] `vscodesync.pauseOnMeteredConnection` (boolean, true)
  - [x] `vscodesync.pauseBatteryThreshold` (number, 15)
  - [x] `vscodesync.watchMode` (boolean, false)
  - [x] `vscodesync.watchIntervalSeconds` (number, 30)
  - [x] `vscodesync.watchMaxIntervalSeconds` (number, 300)
  - [x] `vscodesync.watchAdaptive` (boolean, true)
  - [x] `vscodesync.syncSchedule` (object)
  - [x] `vscodesync.deltaSync` (boolean, false)
  - [x] `vscodesync.deltaThresholdKB` (number, 100)
  - [x] `vscodesync.webhooks.enabled` (boolean, false)
  - [x] `vscodesync.webhooks.url` (string)

---

## Критерий готовности фазы

- [~] Онбординг при первом запуске (новый глобальный config); повтор — `Start Onboarding Wizard`
- [x] Боковая панель показывает активные workspace и отслеживаемые файлы (TreeView `vscodesync.workspaces`)
- [x] Статус-бар всегда актуален (watch `.vscode/vscodesync.json` с перепривязкой при смене корней, multi-root агрегат в строке и tooltip, глобальный config; обновление после push/pull/sync как и раньше)
- [x] Все команды зарегистрированы и работают
- [x] File decorations обновляются после push/pull и при изменении `vscodesync.json` / настройки
