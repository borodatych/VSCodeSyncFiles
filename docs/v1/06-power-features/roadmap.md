# Фаза 6: Power Features

> **Цель:** расширенная функциональность для продвинутых сценариев. После этой фазы: Quick Transfer, Watch Mode, Git-привязка, снапшоты, система исключений, шифрование.

**Зависимости:** [05-providers](../05-providers/roadmap.md) ✅  
**Следующая фаза:** [07-ux-polish](../07-ux-polish/roadmap.md)

---

## Модули этой фазы

| Модуль | Файл | Статус |
|--------|------|--------|
| Quick Transfer | [quick-transfer.md](quick-transfer.md) | `[x]` |
| Watch Mode | [watch-mode.md](watch-mode.md) | `[x]` — polling + адаптивный интервал |
| Git-интеграция | [git-integration.md](git-integration.md) | `[x]` — привязка ветки, auto Suspend/Activate, `gitBranchAutoSync` |
| История версий и Снапшоты | [snapshots-history.md](snapshots-history.md) | `[x]` — create/restore + auto-pre-restore |
| Система исключений | [ignore-system.md](ignore-system.md) | `[x]` — `.vscodesync-ignore` guard + syncignore pipeline |
| Шифрование | [encryption.md](encryption.md) | `[x]` — AES-256-GCM + export/import key |

---

## 6.1 Path Mapping

- [x] Конфиг `pathMapping` в `vscodesync.json`:
  ```json
  "pathMapping": { "home": "D:/Projects/MyApp", "work": "C:/Projects/MyApp" }
  ```
- [x] Применять при Pull: если путь выходит за пределы workspace → заблокировать с ошибкой
- [x] Команда `VSCodeSync: Configure Path Mapping` → quick-edit без ручной правки JSON
- [x] Fallback при отсутствии маппинга: корень текущего workspace

---

## 6.2 Кодировка и Line Endings

- [x] `vscodesync.lineEnding: "lf" | "crlf" | "preserve"` (умолч: `"lf"`)
- [x] Нормализация в canonical pipeline (уже в Foundation, здесь подключить настройку)
- [x] `preserve`: предупреждать при первом конфликте связанном с line endings
- [x] При создании `.vscodesync-ignore`: читать `.editorconfig`, предлагать соответствующий `lineEnding`
- [x] `vscodesync.fileEncoding: "utf8"` (умолч); предупреждение при BOM или non-UTF-8

---

## 6.3 Workspace TTL (архивирование неактивных)

- [x] `vscodesync.workspaceInactiveDays: 90`
- [x] При старте: найти workspace'ы не синхронизировавшиеся > N дней → предложить архивировать
- [x] Архивирование = добавить тег `archived` + Suspend
- [x] Разархивирование: ПКМ → `Unarchive Workspace` → Pull + возобновление
- [x] Тег `archived` скрывает workspace из основного списка

---

## 6.4 Подтверждение новой машины (Machine Approval)

- [x] `vscodesync.requireMachineApproval: false` (умолч)
- [x] При включении: новая машина добавляется в манифест с `status: "pending"` (если в манифесте уже есть другие машины; создатель первой машины остаётся `active`)
- [x] Уведомление на других машинах: `"Новая машина '…' подключилась…"` `[Разрешить]` `[Заблокировать]` `[Позже]` (snooze 24 ч)
- [x] До разрешения: read-only для upload (`push`/добавление/удаление треков); Pull разрешён
- [x] Git Branch auto-activation + pending status: активировать workspace и выполнить только Pull + уведомление про read-only

---

## 6.5 Маппинг путей (Cross-OS)

> Уже частично в Foundation (нормализация `/`). Здесь — пользовательский маппинг.

- [x] Команда `VSCodeSync: Configure Path Mapping`
- [x] Редактировать `pathMapping` без ручной правки JSON
- [x] Проверка при Pull: путь за пределами workspace → блокировать

---

## 6.6 Per-workspace Ignore Patterns

- [x] **Shared** (`sharedIgnorePatterns` в манифесте): через `VSCodeSync: Edit Workspace Ignore Patterns`
- [x] **Local** (`ignorePatterns` в `vscodesync.json`): машино-специфичный override
- [x] Приоритет: глобальный `.vscodesync-ignore` → `sharedIgnorePatterns` → локальный `ignorePatterns`

---

## 6.7 Слияние workspace'ов (`VSCodeSync: Merge Workspaces`)

```
Источник: [ MyApp — оплата    (b91e4f07) ▾ ]
Цель:     [ MyApp — авторизация (a3f8c1d2) ▾ ]
Workspace «оплата» после слияния: [● Удалить  ○ Оставить пустым]
[Объединить]  [Отмена]
```

- [x] Переместить все файлы источника в цель (обновить `cloudPath`, манифесты)
- [x] Авто-снапшот `auto-pre-merge-<date>` обоих workspace'ов перед операцией
- [x] Опционально удалить источник

---

## Критерий готовности фазы

- [x] Quick Transfer работает end-to-end (отправить → получить)
- [x] Watch Mode polling + адаптивный интервал
- [x] Git checkout → авто-активация/деактивация workspace'а
- [x] Снапшоты создаются и восстанавливаются
- [x] `.vscodesync-ignore` блокирует добавление файлов
- [x] Syncignore-блоки корректно вырезаются при push и восстанавливаются при pull
- [x] Шифрование: push → зашифрован, pull → расшифрован, ключ экспортируется
