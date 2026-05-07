# Фаза 7: UX Polish

> **Цель:** финальная полировка пользовательского опыта. Activity Feed, статистика, умные уведомления, Health Check, Smart Suggestions.

**Зависимости:** [06-power-features](../06-power-features/roadmap.md) ✅  
**Следующая фаза:** [08-platform](../08-platform/roadmap.md)

---

## 7.1 Activity Feed (`VSCodeSync: Open Activity Feed`)

Хронологический лог событий синхронизации:

```
Сегодня
  14:35  ↑ push   src/auth/login.ts       [авторизация]   home → OneDrive
  14:32  ↓ pull   src/auth/token.ts       [авторизация]   work → home      (+12/-3 строки)
  13:10  ⚠ conflict  src/payments/checkout.ts  [оплата]   разрешён вручную
  09:15  + added   src/auth/refresh.ts    [авторизация]   добавлен с 'work'
```

- [x] Хранить в `~/.vscode/vscodeSync/activity.json`, rolling window 90 дней (**`vscodesync.activityRetentionDays`**, умолч. 90)
- [x] Webview-панель с фильтрами: по workspace, по машине, по типу события + поиск по пути
- [x] Клик по **пути файла** (или «Открыть») → открыть в редакторе; учитывается **`pathMapping`** и `machineName`. Кнопки **«С облаком»** (`diffWithCloud`) и **«История»** (`showFileHistory` / версии в облаке)
- [x] Экспорт в **CSV / JSON / JSONL** (по отфильтрованным строкам)
- [x] `⚡ auto-resolved (rule: keep-mine)` — при `lineEnding=preserve` и конфликте только по CR/LF: авто-push локальных байтов + запись `resolve_keep_mine` / `meta.autoResolved` + `meta.rule`
- [x] `↑ push (on commit)` — метка в ленте (`pushOnCommit` → `meta.pushOnCommit`)

---

## 7.2 Статистика (`VSCodeSync: Open Stats`)

Webview-дашборд:

- [x] Файлов синхронизировано за неделю / месяц (скользящие **7 / 30 суток** по `activity.json`)
- [x] Push/Pull ratio по машинам (**30 дн.**)
- [x] Топ часто синхронизируемых файлов (**30 дн.**)
- [x] График активности по дням (**30 дн.**)
- [x] Количество разрешённых конфликтов (**7 / 30 дн.**)
- [x] Трафик upload/download за **календарный месяц** (локально, тела запросов push/pull tracked files)
- [x] Экономия от сжатия: поле `bytesSavedByCompressionMonth` + UI; рост счётчика когда движок начнёт отдавать дельту plain vs wire
- [x] Текущий месячный трафик vs `monthlyBandwidthLimitMB`
- [x] `~/.vscode/vscodeSync/stats.json`
- [x] Сброс при смене локального месяца (`trafficMonthKey` YYYY-MM)

---

## 7.3 Уведомления и Notification Digest

- [x] `vscodesync.notificationLevel: "minimal" | "normal" | "verbose"`

  | Уровень | Что показывается |
  |---------|-----------------|
  | `minimal` | Только конфликты и критические ошибки |
  | `normal` | + Quick Transfer, Sync Summary, rate limit предупреждения |
  | `verbose` | Всё: inline diff preview, каждый pull/push с деталями |

- [x] При конфликтах: всегда немедленно, минуя фильтр уровня (`recordDigestConflict`)
- [x] Быстрый переключатель: ПКМ на статус-барe → `Set Notification Level` (меню `statusBar/item/context` в `package.json`)
- [x] Команда `VSCodeSync: Set Notification Level`
- [x] **Notification Digest** (`vscodesync.digestIntervalMinutes: 30`):
  - При `normal` + `digestIntervalMinutes > 0`: группировать в один тост
    ```
    ☁ VSCodeSync — за последние 30 мин:
      ↓ 8 файлов обновлено с 'work'
      ✅ 3 файла запушено
      0 конфликтов
    [Показать детали]  [Закрыть]
    ```
  - `digestIntervalMinutes: 0` → немедленные уведомления
  - `verbose` → digest игнорируется
  - `minimal` → digest не показывается
  - Конфликты и ошибки всегда немедленно

---

## 7.4 Health Check (`VSCodeSync: Health Check`)

```
VSCodeSync Health Check — 2026-04-28 14:35

  ✅ OneDrive: подключен, токен действителен (до 2026-05-28)
  ✅ Workspace «авторизация» (a3f8c1d2): манифест OK, 2 файла
  ⚠ Workspace «оплата» (b91e4f07): stale soft lock на src/payments/checkout.ts (home, 3ч.)
  ✅ Оффлайн-очередь: пуста
  ✅ Lock-файл: нет (нет параллельных окон)
  ❌ _machines.json: не обновлялся > 24ч

[Починить stale lock]  [Сбросить _machines.json]  [Закрыть]
```

- [x] Output panel или Webview с результатами
- [x] Только читает данные (без изменений если не нажать кнопки)
- [x] Кнопки починки по явному нажатию
- [x] Те же данные что и индикатор здоровья workspace'а в боковой панели (локально — `workspaceHealthFromLocalCfg`; облако — тот же `healthCheckWorkspace` + манифест для soft lock)

---

## 7.5 Smart Workspace Suggestions

- [x] Анализировать `activity.json` локально (без облачных запросов)
- [x] Если файлы стабильно редактируются вместе (≥5 раз за 2 недели) и не в одном workspace:
  ```text
  💡 Вы часто редактируете эти файлы вместе:
     src/auth/login.ts  •  src/middleware/auth.ts  •  src/types/user.ts
  Создать workspace «авторизация» для них?
  [Создать]  [Игнорировать]  [Не спрашивать снова]
  ```
- [x] Если workspace не использовался > 60 дней (и `workspaceInactiveDays` > 60): мягкий вопрос об архиве до порога «полного» неактивного сканера
- [x] Запускать не более раз в сутки при старте VSCode (`globalState` по локальной дате)
- [x] `vscodesync.smartSuggestions: true` (умолч)

---

## 7.6 Экспорт / импорт структуры workspace'а

- [x] `VSCodeSync: Export Workspace Structure` — без токенов и содержимого (**schema 2**):
  ```json
  {
    "schema": 2,
    "sourceWorkspaceId": "a3f8c1d2",
    "workspaceNote": "MyApp — авторизация",
    "files": ["src/auth/login.ts", "..."],
    "exportedAt": "...",
    "exportedBy": "home"
  }
  ```
  В диалоге экспорта: **портативная структура** или **полный локальный кэш** (schema 1, как раньше).
- [x] `VSCodeSync: Import Workspace Structure`:
  - schema 2: подключение к облаку (`attachCloudWorkspace`) или создание нового workspace + `addFiles`; если workspace уже в проекте — только недостающие файлы из списка
  - Если манифест на облаке есть → выбор: подключиться или создать новый workspace
  - Конфликты контента после подключения — существующий поток (дерево, diff с облаком)
  - Требует Workspace Trust

---

## 7.7 Телеметрия

- [x] `vscodesync.telemetry: false` (умолч, выключена)
- [x] Шаг 4 онбординга: opt-in/out (см. onboarding.md)
- [x] Собирать: тип событий (`vscodesync.activate` — раз в сутки UTC), кол-во строк workspace / трекаемых файлов (числа), версия расширения, провайдер (строка типа)
- [x] НЕ собирать: имена файлов, содержимое, токены, пути (в наших полях активации)
- [x] Внешний приём: опционально `vscodesync.telemetryIngestUrl` (POST JSON) — пустой по умолчанию; для AI/Posthog задаётся вручную
- [x] Следовать стандарту [VSCode Telemetry API](https://code.visualstudio.com/api/extension-guides/telemetry) (`vscode.env.createTelemetryLogger`)
- [x] Команда `VSCodeSync: Toggle Telemetry`

---

## 7.8 Добавление папки в синхронизацию (рекурсивно)

**Проблема:** сейчас в sync попадают только **отдельные файлы** (ПКМ по файлу, мультивыбор файлов, диалог «выберите файл»). При большом числе файлов в одной директории поштучное добавление неприемлемо.

**Цель:** одной операцией добавить **все подходящие файлы** из выбранной **папки** (и из нескольких папок при мультивыборе в Explorer), с теми же правилами безопасности, что и для одиночного файла.

### Поведение (спека)

- [x] **ПКМ в Explorer** на **папке**: пункт VSCodeSync «Добавить …» (та же команда, что и для файла), видимый только для добавления (без push/pull по папке).
- [x] **Команда палитры** «Добавить текущий файл …»: диалог выбора допускает **файл или папку** (`canSelectFolders: true`), если нет активного редактора.
- [x] **Рекурсия:** обход вложенных каталогов; **только файлы** (не создаём «пустые» узлы папок в облаке — как и сейчас, в манифесте только файлы с относительными путями).
- [x] **`.vscodesync-ignore` + shared/manifest + local ignore:** те же комбинированные правила, что и у `guardPathsBeforeAdd` / одиночного файла; совпавшие пути **молча пропускаются** (не ошибка).
- [x] **Симлинки:** как при обходе — если ведут в каталог, обходим; если на файл — учитываем файл; битые — пропуск.
- [x] **За пределами корня workspace** выбранные пути не расширяются (как при мультивыборе файлов — привязка к корню папки).
- [x] **Подтверждения UX:**
  - при **одном** явно выбранном **файле** — прежний превью-диалог (если включён `showPreview`);
  - при **нескольких файлах** или **любом добавлении из папки** — без поштучного превью; один модальный вопрос «Добавить N файлов?» перед проверками;
  - **бинарные файлы:** при N>1 — **одно** предупреждение со списком/счётчиком, а не N модалок;
  - при **>500** файлов — дополнительное предупреждение о масштабе;
  - **0 файлов** после фильтрации — понятное сообщение (все в ignore / пустая папка).
- [x] **Реализация:** утилита сбора путей (например `collectFilesToAddUnderRoots`) + доработка обработчика `vscodesync.addCurrentFile` и `package.json` (меню для папок, заголовок команды).

---

## 7.9 Добавить в новый воркспейс (ПКМ)

**Цель:** без отдельного шага «Создать workspace» создать облачный воркспейс и сразу залить выбранные **файлы / папку** (рекурсивно), с теми же guards, что и при добавлении в существующий.

- [x] Команда **`vscodesync.addToNewWorkspace`**: ввод названия → `createWorkspace` → `collectFilesToAddUnderRoots` → `guardPathsBeforeAdd` → `addFiles`.
- [x] Тот же предупреждение о **дубликате имени** в облаке, что у «Создать воркспейс».
- [x] **ПКМ:** в подменю VSCodeSync для **файлов**; отдельная строка для **папки** в Explorer (рядом с «Добавить папку…»).
- [x] Пустой итог после ignore / отмена guards — воркспейс уже создан; тексты сообщений это отражают.

---

## Критерий готовности фазы

- [x] Activity Feed: события, фильтры, экспорт, открытие с pathMapping, diff с облаком и история из строки
- [x] Stats dashboard — webview и основные виджеты ✓ (расширенные графики при необходимости)
- [x] Health Check выявляет все известные проблемы
- [x] Smart Suggestions предлагают разумные группировки
- [x] Notification Digest группирует уведомления
