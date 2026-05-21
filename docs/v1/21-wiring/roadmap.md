# Фаза 21: Phase 21 — User-visible wiring (v0.15)

> **Цель:** превратить 13 «оставшихся pure helpers без caller'ов» из v0.8-v0.14 в реально доступные пользователю команды, hooks, и UI entries. Точечная wiring-волна, без новой функциональности.

**Зависимости:** v0.14 (все helpers готовы и unit-тестированы)
**Следующая фаза:** [22-modern-features](../22-modern-features/roadmap.md)

---

## 21.1 W01 — Repair Cloud Manifest

- [x] Команда `vscodesync.repairCloudManifest` (palette + Health Check)
- [x] Вызывает `planRepairManifest` после scan `_meta` + `_machines.json`
- [x] Confirmation modal с превью plan (`describeRepairPlan`)
- [x] Activity log событие `manifest_repaired` (ActivityKind добавлен)

## 21.2 W02 — Explain File Sync State

- [x] Команда `vscodesync.explainFileSyncState <uri>`
- [x] Использует `explainFileSyncState` chain из 10 проверок
- [x] Output Channel `VSCodeSync · Explain` с Markdown
- [ ] Context menu в Explorer (deferred — нужна menus.json contribution)
- [ ] Context menu в Workspaces tree (deferred)

## 21.3 W03 — Keep Both Conflict

- [x] Команда `vscodesync.resolveConflictKeepBoth`
- [x] Wires `SyncEngine.resolveConflictKeepBoth`
- [x] ActivityKind `resolve_keep_both` (отдельный bucket)
- [x] Title в RU/EN nls
- [ ] Кнопка в conflict QuickPick (deferred — нужна правка `registerConflictsCommands`)

## 21.4 W04 — Contextual Hints Scheduler

- [x] `registerContextualHintsScheduler` — hook на `onDidChangeWindowState` focus regain
- [x] Initial check 30s после activate
- [x] Setting `vscodesync.hints.enabled` (default `true`)
- [x] Dedup через globalState (6h window per hint id)
- [x] `autoSyncOffSinceMs` отслеживается в globalState

## 21.5 W05 — `vscodesync://` URI Handler

- [x] `vscode.window.registerUriHandler` в новом `vscodeSyncUriHandler.ts`
- [x] Адаптер от VS Code URI shape (`vscode://<ext-id>/...`) к нашему `vscodesync://`
- [x] Команда `vscodesync.copyShareUri` для текущего файла
- [x] Whitelist guard на `vscodesync://command/<id>`

## 21.6 W06 — Provider Hash Verify

- [ ] Wires `expectedProviderDigests` в `SyncEngine.pushFile` после upload (deferred — engine touch)
- [ ] Setting `vscodesync.providerHashVerify` (default `true`) (deferred)
- [ ] При несовпадении — retry через `withRetry` (deferred)

## 21.7 W07 — Quota Exhaustion Banner

- [ ] Catch `STORAGE_QUOTA_EXCEEDED` в engine paths (deferred — нужна engine integration)
- [ ] Gather `TrackedFileWeight[]` из cfg + `getMetadata`
- [ ] `showWarningMessage` с топ-5 файлов

## 21.8 W08 — withRetry в провайдерах

- [ ] Wrap `apiFetch` / `driveFetch` / `graphFetch` через `withRetry` (deferred — provider touch)
- [ ] Нормализация `TypeError: fetch failed` → `ProviderError("NETWORK_ERROR")`

## 21.9 W09 — .gitignore Watcher

- [x] `registerGitignoreWatcher` — focus regain + folder change triggers
- [x] Использует `detectMissingGitignoreEntries` / `ensureManagedBlock`
- [x] 5-min dedup на per-folder prompt
- [x] Initial check 10s после activate

## 21.10 W10 — AI Explain Conflict

- [x] Команда `vscodesync.aiExplainConflict <uri>`
- [x] Вызывает `buildExplainConflictPrompt`
- [x] Copilot LM path (`vscode.lm.selectChatModels`) если доступен
- [x] Fallback: copy prompt to clipboard для manual paste

## 21.11 W11 — Support Bundle Export

- [x] Команда `vscodesync.exportSupportBundle`
- [x] Использует `buildSupportBundleManifest` + `redactSettings`
- [x] Output: `~/.vscode/vscodeSync/support-<ts>/` directory
- [x] Reveal in OS file manager после экспорта
- [ ] Zip wrapper (deferred — нужна `archiver` dep) — пока папка

## 21.12 W12 — Quick Switch UI

- [ ] Replace existing `vscodesync.quickSwitchWorkspace` с `buildQuickSwitchItems` (deferred — UI replacement)
- [ ] Hourly counts builder из Activity Feed (deferred)
- [ ] User-pinned set в globalState (deferred)

## 21.13 W13 — Dropbox Upload Session

- [ ] Wires `planDropboxUpload` в `dropboxProvider.uploadFile` (deferred — provider touch)
- [ ] Per-chunk retry через `withRetry` (deferred, зависит от W08)

## 21.14 W14 — Workspace Context Detector

- [ ] Wires `detectWorkspaceContext` в attach flow (deferred — UI wiring)
- [ ] Worktree fold + devcontainer badge в Workspaces tree (deferred)
