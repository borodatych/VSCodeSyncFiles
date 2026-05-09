# Боковая панель (Activity Bar)

> TreeView с workspace'ами и файлами. Два раздела: активные и доступные на облаке *(секция «Доступные на облаке» — только неподключённые workspace'ы)*.

**Часть фазы:** [03-ui](roadmap.md)

---

## Структура панели

```
[ 🔍 Поиск workspace'ов...                                          ]
Фильтр: [work ×]  [active ×]  [ + добавить тег ]

▼ 📁 MyApp (корень 1)                          ← multi-root группировка

  ▼ 🟢 ✅ MyApp — авторизация   work active  (a3f8c1d2) · 14:32
       🟢 work · активна 8 мин. назад
       🟢 home · сейчас (вы)
       src/auth/login.ts       ↑    Push  Pull  Diff  ✕
       src/auth/token.ts       ✓    Push  Pull  Diff  ✕
    [Push All]  [Pull All]  [⏸ Pause]  [🔒 Deep Freeze]  [Detach]  [Delete]

  ▼ 🟡 ⚠ MyApp — оплата        (b91e4f07) · 13:10
       src/payments/checkout.ts  ⚠ Conflict
       src/payments/invoice.ts   ✓    Push  Pull  Diff  ✕
    [Push All]  [Pull All]  [⏸ Pause]  [🔒 Deep Freeze]  [Detach]  [Delete]

─── Доступные на облаке ───────────────────────────────────
  ☁ Backend стенд — nginx    (c2d8a31f) · вчера 09:15   [Connect]
  ☁ Домашний pet-project     (cc2d8a31) · 3 дня назад   [Connect]
```

---

## TreeView реализация

- [x] Зарегистрировать `TreeDataProvider` для view `vscodesync.workspaces` (`WorkspacesTreeProvider`)
- [x] Узлы: при **multi-root** — группа по корневой папке → `WorkspaceNode` → `FileNode`; при одной папке — сразу workspace → файлы
- [x] Узлы **«Доступные на облаке»** — `listRemoteWorkspaceSummaries` минус уже подключённые к любой открытой папке; клик / `Connect Cloud Workspace (Tree)` → `attachCloudWorkspace` в первую папку workspace (как палитра `Connect to Cloud Workspace`)
- [x] Lazy loading файлов — всё из локального `vscodesync.json` (полная загрузка при раскрытии workspace)
- [x] `refresh()` при изменении `vscodesync.json`, после push/pull/sync (`runWithEngine`), сохранении конфига

---

## Поиск и фильтрация

- [x] Строка поиска (input) — фильтрует по `workspaceNote` в реальном времени (`Filter Workspaces…` / InputBox, подсветка в `description` панели; по ID workspace тоже)
- [x] Тег-фильтры: QuickPick с мультивыбором (AND) + ПКМ workspace «добавить тег в фильтр панели»; иконка в заголовке панели
- [x] Работают поверх друг друга (AND-логика) с текстовым фильтром по заметке
- [x] Специальный тег `archived` → скрывать из основного списка по умолчанию; показ — команда «Toggle Show Archived Workspaces» или фильтр тега `archived`

---

## Индикатор здоровья workspace (🟢/🟡/🔴)

- [x] 🟢 — всё OK: нет конфликтов, последний `lastSync` любого файла workspace < 24 ч (или нет файлов)
- [x] 🟡 — не синхронизировался 24 ч–7 дн., или невалидные даты `lastSync`
- [x] 🔴 — неразрешённые конфликты ИЛИ > 7 дней по `lastSync`
- [x] 🟡 из-за активного soft lock (`editingBy` в кэше `TrackedFile.editingBy`) — `workspaceHealthFromLocalCfg` проверяет `files[].editingBy`
- [x] Hover → tooltip: блок **Состояние (локально)** с теми же строками, что в Health Check
- [x] Локальная часть совпадает с блоком «локально» в `VSCodeSync: Health Check`; облако — по-прежнему проверка манифеста (тот же проход команды)

---

## Индикатор присутствия машин

- [x] У каждого workspace в tooltip — список машин с 🟢 &lt; 30 мин / 🟡 30 мин–24 ч / 🔴 &gt; 24 ч по `lastSeen`
- [x] `… · сейчас (вы)` для машины с `machineId` из глобального config
- [x] Данные из кэша `manifestMachines` (тот же снимок, что в манифесте; обновляется при sync / repair / put manifest)

---

## Мягкая блокировка (Soft Lock) в панели

- [x] Если файл `editingBy` другой машиной → иконка ✏️ видна через `manifestMachines` кэш в дереве (данные из манифеста)
- [x] `setSoftLock(workspaceId, posixRel)` в engine — устанавливает `editingBy = machineId, editingSince = now` в манифесте
- [x] `clearSoftLock(workspaceId, posixRel)` — снимает только собственный lock
- [x] Unit-тест: `tests/unit/softLock.test.ts` — setSoftLock/clearSoftLock/only-own-lock/skip-locked-file
- [x] Unit-тест: `tests/unit/onedriveTokenRefresh.test.ts` — maybeRefreshToken: valid/skips без clientId/no-refresh/обновляет/invalid_grant/fallback на network error
- [x] Lifecycle в extension.ts: `onDidChangeActiveTextEditor` → setSoftLock; `onDidCloseTextDocument` → clearSoftLock; heartbeat 10 мин + timeout 60 мин через `setInterval`
- [x] Проверять только если `editingBy !== currentMachineId` — реализовано
## Soft Lock в дереве

- [x] `TrackedFile.editingBy` и `editingByName` — кэшируются из манифеста во время `syncWorkspace`
- [x] При `editingBy !== machineId` и `editingBy != null`: в дереве Workspaces иконка ✏️ + description «✏️ machineName»
- [x] Tooltip: «✏️ Редактируется на '{machine}'»

---

## Drag-and-Drop

- [x] Реализовать `TreeDragAndDropController` (`WorkspacesTreeDnD`, mime `application/vnd.code.tree.vscodesync.workspaces`)
- [x] Перетаскивать `FileNode` на другой `WorkspaceNode` *(внутри одной корневой папки VS Code; multi-root между корнями — блокируется)*
- [x] Диалог подтверждения перед перемещением *(один файл — «из … в …», несколько — счётчик + имя целевого workspace)*
- [x] Multi-drag (Ctrl+выбор + drag) — `handleDrag` принимает несколько узлов; то же подтверждение и пакетный `remove`/`add`

---

## Кнопки workspace'а

- [x] Push/Pull/Sync — через контекстное меню узла workspace (`treeWorkspace*`); при `vscodesync.showPreview` — предпросмотр плана и подтверждение
- [x] `[⏸ Pause]` (= Suspend) — отключены push/pull файлов; обновление манифеста (rename/tags/git branch и heartbeat через операции, не замороженные файловым sync) — см. `syncState: suspended` в `vscodesync.json`; палитра + ПКМ дерева
- [x] `[🔒 Deep Freeze]` (= Freeze) — без push/pull файлов и без PUT манифеста/`_meta`; палитра + ПКМ дерева (`syncState: frozen`)
- [x] `[Detach]` — отключить workspace от текущей папки (палитра `Detach Workspace...`, ПКМ узла workspace в дереве — `Detach Workspace (Tree)`)
- [x] Переименовать заметку workspace — палитра `Rename Workspace Note`, ПКМ узла — `Rename Workspace Note (Tree)`
- [x] Health Check одного workspace — ПКМ `Health Check (Tree)` (палитра `Health Check` — все workspace активной корневой папки)
- [x] `[Delete]` — удалить workspace с облака (`VSCodeSync: Delete Workspace from Cloud…`, ПКМ узла workspace); без восстановления данных под `VSCodeSyncFiles/{id}/`; локальный detach как после команд удаления

---

## Кнопки файла

- [x] Push/Pull — контекстное меню файла (`treeFilePush` / `treeFilePull`) реализованы
- [x] `Diff` — пункт меню → `VSCodeSync: Diff with Cloud` (`resolveFileTargetLoose` для элемента дерева)
- [x] Убрать из трекинга — `Remove from Sync` в контексте файла в дереве (тот же `vscodesync.removeFromSync` + `resolveFileTargetLoose`)

---

## Preview синхронизации

> Перед `Push All`, `Pull All`, `Sync Workspace`

- [x] Показывать предпросмотр: сводка счётчиков (↓pull/↑push/⚠conflict) + модальное окно «Выполнить / Отмена», детали — Output «VSCodeSync · Preview» (`confirmTreeWorkspaceBulkSyncIfNeeded`); Rich UI и «Пропустить конфликты» — позже
- [x] `vscodesync.showPreview: false` — отключить предпросмотр добавления файла и массовых операций из дерева
- [x] Работает и для Push — через те же команды дерева (`treeWorkspacePushAll` / Pull / Sync)

---

## Sync Summary (панель)

> После Pull при старте VSCode если что-то изменилось

- [x] Показывать панель **Sync Summary** (`informationMessage` с `detail`, кнопки «Открыть изменённые файлы» / «Закрыть»): сводка по разнице `vscodesync.json` до/после startup **pull** по каждой корневой папке с активными workspace
- [x] Если ничего не изменилось — не показывать
- Настройка: `vscodesync.syncSummaryOnStartup` (умолчание `true`); задержка ~4 с после активации; без активных workspace в папке pull не выполняется

---

## Уведомление о долгом отсутствии

- [x] Если > `vscodesync.longAbsenceThresholdDays` дней без синхронизации:
  - [x] Startup check: `newestTrackedLastSyncMs` vs `longAbsenceThresholdDays * 86400s`; `showWarningMessage` с кнопками «Preview» / «Синхронизировать» / «Пропустить»
