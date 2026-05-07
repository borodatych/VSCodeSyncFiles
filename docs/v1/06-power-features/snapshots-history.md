# История версий и Снапшоты

> Облачная история файлов (до 10 версий) и именованные снапшоты всего workspace'а.

**Часть фазы:** [06-power-features](roadmap.md)  
**Реализация:** `src/core/syncEngine.ts` (`snapshotHistory`, `pruneHistory`), `src/core/snapshotsEngine.ts`

---

## История версий (`.history/`)

```
VSCodeSyncFiles/{workspaceId}/.history/src/auth/login.ts/
  2026-04-28T14-32-00_home.ts
  2026-04-28T09-15-00_work.ts
```

- [x] При каждом успешном Push: `snapshotHistory` записывает копию в `.history/` перед overwrite
- [x] Имя файла: `{ISO-timestamp-с-дефисами}_{machineName}{ext}` (safe chars, коллизий нет у разных машин)
- [x] Лимит `HISTORY_VERSIONS = 10`: `pruneHistory` при превышении удаляет самую старую
- [x] Команда `VSCodeSync: Show File History`: quick-pick версий → можно открыть diff с локальным (`showFileHistory` в extension.ts)

---

## Show File History

- [x] Quick-pick со списком:
  ```
  📁 local backup · 2026/04/29 14:35
  ☁ home · сегодня 14:32
  ☁ work · сегодня 09:12
  ```
- [x] Показывает: облачные версии из `.history/` + локальные бэкапы из `.vscode/vscodesync-local-backup/` (отсортированы по времени, `📁` префикс)
- [x] Клик → diff preview `vscode.diff(local, version)` или открыть файл напрямую

---

## Снапшоты (`VSCodeSync: Create Snapshot`)

```
VSCodeSyncFiles/{workspaceId}/.snapshots/2026-04-28_перед-деплоем/
  src/auth/login.ts
  .snapshot-meta.json
```

- [x] Команда `VSCodeSync: Create Snapshot` — inputBox имя, quick-pick workspace, progress + `createWorkspaceSnapshot`
- [x] Загружает все файлы workspace'а в `.snapshots/{name}/` + `.snapshot-meta.json`

---

## Восстановление снапшота (`VSCodeSync: Restore Snapshot...`)

- [x] Quick-pick снапшотов (пользовательские / системные 🔒)
- [x] Авто-снапшот `auto-pre-restore-{date}` перед восстановлением
- [x] Требует Workspace Trust (блокируется в Restricted Mode)

---

## Авто-снапшоты перед деструктивными операциями

| Операция | Авто-снапшот |
|----------|-------------|
| `Restore Snapshot...` | `auto-pre-restore-{date}` ✅ |
| `Migrate to Another Provider` | `pre-migration-{date}` ✅ |
| `Merge Workspaces` | `auto-pre-merge-{date}` ✅ |
| `Delete from Cloud` | снапшот не создаётся |
| `Pull All` с конфликтами | — не реализовано |
| `Rotate Encryption Key` | — не реализовано |
