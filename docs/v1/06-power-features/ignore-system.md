# Система исключений

> `.vscodesync-ignore`, syncignore-блоки внутри файлов, per-workspace паттерны.

**Часть фазы:** [06-power-features](roadmap.md)

---

## `.vscodesync-ignore` (глобальный)

- [x] При добавлении файла в трекинг: проверить против `.vscodesync-ignore`; если совпадает → блокировать (`guardPathsBeforeAdd` в `syncGuards.ts`)
- [x] При добавлении папки: применять фильтр рекурсивно (через `ignoreMatch`)
- [x] Дефолтное содержимое: `node_modules/`, `dist/`, `.env*`, `*.key` и т.д. (`ensureWorkspaceGitignoreEntry`)
- [x] Авто-импорт из `.gitignore`: при создании `.vscodesync-ignore` предлагает «Импортировать / Пропустить»; при согласии — prepend контента `.gitignore` в новый файл

---

## Per-workspace ignore patterns

- [x] **Shared** в манифесте: `sharedIgnorePatterns` — через `VSCodeSync: Edit Workspace Ignore Patterns`
- [x] **Local** в `vscodesync.json`: `ignorePatterns` — только на данной машине

---

## Syncignore-блоки внутри файлов

- [x] Push (sanitize): вырезать блоки между `vsync-ignore-start` / `vsync-ignore-end` перед хэшированием (`extractSyncignoreInners` в `syncignore.ts`)
- [x] Pull (merge): локальное содержимое блоков не перезаписывается (`mergeSyncignoreFromCloud`)
- [x] Пересчитать hash после merge → сохранить в `localHash`
- [x] При add: сканировать на маркеры → выставить `hasSyncignoreMarkers` в манифест (`fileHasSyncMarkers`)
- [x] Поддержка стилей комментариев: `//`, `#`, `--`, `<!-- -->`

---

## Canonical pipeline

**Push:** `normalize_line_endings → sanitize_syncignore → SHA-256 → [gzip] → [encrypt] → upload` ✅  
**Pull:** `download → [decrypt] → [decompress] → merge_syncignore → write → hash → update vscodesync.json` ✅

- [x] Unit-тест: hash не меняется при pull если содержимое не изменилось (`tests/unit/syncignore.test.ts` и другие)
