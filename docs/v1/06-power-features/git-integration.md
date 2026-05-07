# Git-интеграция

> Привязка workspace'а к git-ветке, Timeline, File Decorations (уже в UI-фазе), Sync on Commit.

**Часть фазы:** [06-power-features](roadmap.md)

---

## Привязка к git-ветке (`gitBranch`)

- [x] Команда `VSCodeSync: Set Git Branch for Workspace...`: quick-pick веток, запись `gitBranch` в манифест
- [x] Workspace без `gitBranch` — всегда активен независимо от ветки

---

## Детекция смены ветки

- [x] GitExtension API: `vscode.extensions.getExtension('vscode.git').getAPI(1)` + `repository.onDidChange`
- [x] Fallback: `fs.watch` на `.git/HEAD`
- [x] Multi-root: отдельный слушатель на каждую папку
- [x] Настройка отключения: `vscodesync.gitBranchAutoSync`

---

## Авто-активация/деактивация при git checkout

- [x] При смене ветки: workspace с совпадающим `gitBranch` → `Resume` + `syncWorkspace`
- [x] Другие workspace'ы с заданным `gitBranch` → `Suspend`
- [x] Перед Suspend при несинхронизированных файлах: диалог Push / Suspend без push / Отмена
- [x] `blocked` / `pending` машины → автоактивация по ветке пропускается + уведомление

---

## Sync on Git Commit (`pushOnCommit`)

- [x] `vscodesync.pushOnCommit: false` (умолч)
- [x] При включении: `git diff-tree` на HEAD → пушить закоммиченные файлы в трекинге (`syncTriggerManager.ts`)
- [x] В Activity Feed: `↑ push (on commit)` (метка `meta.pushOnCommit`)

---

## VSCode Timeline Integration

- [x] `SyncTimelineProvider` зарегистрирован через runtime API (`registerTimelineProvider` на `"file"`)
- [x] Показывает события из `activity.json` для активного файла: push/pull/conflict/resolve
- [x] Клик на событие → `vscodesync.diffWithCloud` с текущей версией
- [x] Клик на push/pull событие в Timeline → `showFileHistory` (выбор версии из облачной истории)

---

## Совместимость: Pause + Git Branch

- [x] Git auto-policy не зависит от session pause
- [x] При Resume → Preview накопившихся изменений: `previewSyncPlan(wsId)` → `showInformationMessage` с ↓pull/↑push/⚠conflict; кнопки «Синхронизировать» / «Позже» (уважает `vscodesync.showPreview`)
