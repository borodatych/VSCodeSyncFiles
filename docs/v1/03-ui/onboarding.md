# Онбординг-мастер (первый запуск)

> Пошаговый мастер при первом старте (новый `config.json`). Существующие установки без поля `onboardingCompleted` не тревожим.

**Часть фазы:** [03-ui](roadmap.md)

---

## Шаги мастера

```
Шаг 1/4 — Имя этой машины
  Как называть эту машину в истории и уведомлениях?
  > [ home           ]
  Примеры: home, work, laptop, macbook

Шаг 2/4 — Облачный провайдер
  > ● OneDrive   ○ Google Drive   ○ Яндекс Диск   ○ Dropbox
  [Войти через браузер]

Шаг 3/4 — Подключить workspace
  ○ Создать новый workspace
  ● Подключиться к существующему (список с облака)
  ○ Пропустить — настрою позже

Шаг 4/4 (опционально) — Телеметрия
  Разрешить анонимную телеметрию?
  Собирается: тип событий, кол-во workspace'ов, версия расширения, провайдер.
  НЕ собирается: имена файлов, содержимое, токены, пути.
  ○ Включить  ● Выключить
```

---

## Реализация

- [x] `GlobalConfig.onboardingCompleted` + миграция: старый `config.json` без поля → `true`
- [x] При активации расширения: если `onboardingCompleted === false` → мастер
- [x] Мастер: `showInputBox` / `showQuickPick` (без Webview)
- [x] Шаг 1: `machineName`, валидация (не пусто, без `/` `\`); дефолт: hostname / эвристика remote
- [x] Уникальность в `_machines.json`, постфикс при коллизии (после шага провайдера при доступе к облаку; `machineRegistry.ts` + фоновое обновление `lastSeen` при старте)
- [~] Шаг 2: выбор провайдера; OneDrive → опционально `Sign in` если задан clientId
- [x] Шаг 3: создать workspace (команда), **подключиться к существующему** (`Connect to Cloud Workspace`) или пропуск
- [x] Шаг 4: телеметрия → `vscodesync.telemetry` в настройках
- [x] По завершении: `onboardingCompleted: true` (первая синхронизация не запускается автоматически)
- [x] Подсказка про keyboard shortcuts текстом (назначение вручную в Keyboard Shortcuts) + кнопка открытия с поиском `vscodesync`
- Команда **VSCodeSync: Start Onboarding Wizard** (`vscodesync.startOnboarding`)

---
## Remote Development (WSL / SSH / Codespaces)

- [x] Дефолт имени машины: эвристики по `remoteName` + (для SSH) authority `vscode-remote://…`, переменные Codespaces, `os.hostname()` локально (`machineNameSuggest.ts`)
- [x] Шаблоны: `wsl-<distro>` (из `wsl+…`), `codespace-<repo|CODESPACE_NAME>`, `ssh-<hostName>` (из base64 JSON в authority), `devcontainer`
- [x] Отдельная кнопка Device Code для headless — команда `vscodesync.onedriveSignInHeadless` (Output «VSCodeSync · OneDrive», без `openExternal`); в мастере — пункт QuickPick «Device Code (headless…)»

---
## Workspace Trust (Restricted Mode)

- [x] В Restricted Mode:
  - Push и Pull работают нормально
  - `Import Workspace Structure` и `Restore Snapshot...` заблокированы (требуют Trust)
  - Показывать предупреждение при попытке заблокированных операций
