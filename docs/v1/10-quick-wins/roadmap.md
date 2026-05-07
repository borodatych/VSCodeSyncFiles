# Phase 10 — Quick Wins

> Дешёвые UX-фичи, добавленные одной волной поверх Hardening.

## Статус: `[~]` (4 из 9 сделано в этой сессии)

## Сделано

- [x] **Welcome view** в дереве «Workspaces» при пустом списке — `viewsWelcome` в `package.json` с двумя ветками (есть/нет открытой папки). Команды: `vscodesync.createWorkspace`, `connectCloudWorkspace`, `startOnboarding`, `showProviderSetupGuide`.
- [x] **Quick Switch hotkey** — `Ctrl+Alt+W` (`Cmd+Alt+W` на Mac) → `vscodesync.quickSwitchWorkspace`: QuickPick всех workspace в открытых папках, отсортированных по `lastSync` desc, с иконкой `$(debug-pause)` для suspended.
- [x] **Recently changed smart group** — `WorkspacesTreeProvider.workspacesUnderFolder` теперь сортирует workspace по `max(file.lastSync)` desc; пустые (без активности) уходят в конец и сортируются по `localeCompare` имени.
- [x] **Status bar accent + badge на конфликтах** — уже было реализовано: `statusBarItem.warningBackground` + `$(warning) N conflicts` суффикс. Подтверждено и оставлено.

## Сделано в ночной волне

- [x] **CodeLens «Last sync from MachineX 5m ago»** — `src/ui/lastSyncCodeLens.ts` + setting `vscodesync.codeLens.enabled`. Показывает freshness, editor, кнопку Pull при `cloud_newer` и Resolve при `conflict`.
- [x] **Hover-tooltip на FileDecoration** — `buildTooltip()` в `fileDecorations.ts`: status icon + `last sync N ago` + editor + `workspace ID short`.
- [x] **Force pull from machine X** — команда `vscodesync.forcePullFromMachine` (через `showFileHistory`, который уже умеет лиситинг по `_machineId` в `.history/`).
- [x] **Compare workspace state (local↔cloud diff)** — команда `vscodesync.diffWorkspaceManifest`: вывод в `OutputChannel` с тремя секциями (только локально / только облако / в обоих).

## Отложено

- [x] **Pin file (priority queue)** — `priority?: boolean` поле в `OfflineQueueItem`, новая публичная функция `sortPriorityFirst()` в `syncOfflineQueueStore.ts`, команда `vscodesync.pinFileForSync` (ПКМ или палитра — pin для активного файла). Pinned items идут после fullSync, до обычных push/pull, до quickTransfer. 6 unit-тестов на сортировку (включая stability и edge-кейсы).
