# Фаза 19: DX & Quality (v0.13)

> **Цель:** покрыть критические непокрытые куски тестами, выровнять devcontainer/git worktree поведение, защитить от регрессий через contract tests.

**Зависимости:** v0.12 (стабильные провайдеры)
**Следующая фаза:** [20-modern-bonus](../20-modern-bonus/roadmap.md)

---

## 19.1 Unit tests на основной API SyncEngine (F-050)

Сейчас syncEngine.ts ~3900 LoC и pure helpers вытащены наружу — но сам engine не имеет своих unit-тестов на ключевые public методы. `MockCloudProvider` уже есть.

- [ ] `tests/unit/syncEngine.syncWorkspace.test.ts` — happy path, conflict detection, checkOnly mode, lazy history drain
- [ ] `tests/unit/syncEngine.pushFile.test.ts` — push с/без verify, gzip/zstd, encryption, ETag race, file lock
- [ ] `tests/unit/syncEngine.pullFile.test.ts` — pull с conditional GET notModified, integrity check, local backup
- [ ] `tests/unit/syncEngine.forcePullWorkspace.test.ts` — bypass soft-lock, mass-update
- [ ] `tests/unit/syncEngine.checkWorkspaceStatus.test.ts` — статусы без push/pull
- [ ] Target coverage: >70% lines на `syncEngine.ts`

## 19.2 HTML snapshot tests (F-051)

Существующие snapshot tests: `quotaDashboardHtml`, `passkeyDevicesFormatter`, `visualMergerHtml`, `syncReplayViewerHtml`, `conflictHeatmapSarif`. Не покрыто:

- [ ] `tests/unit/commandCenter.snapshot.test.ts`
- [ ] `tests/unit/settingsPanel.snapshot.test.ts`
- [ ] `tests/unit/webauthnWebview.snapshot.test.ts`
- [ ] `tests/unit/statsDashboardPanel.snapshot.test.ts`
- [ ] `tests/unit/sankeyChartPanel.snapshot.test.ts`
- [ ] `tests/unit/statusPanel.snapshot.test.ts` (после F-014)

Для каждого — `expect(html).toMatchInlineSnapshot()` + ручная проверка структуры.

## 19.3 Contract tests на ICloudProvider (F-052)

- [ ] `tests/integration/providerContract.test.ts`:
  - Для каждого провайдера (mock, gdrive, onedrive, yandex, dropbox — через MockTransport):
    - `uploadFile(404 path)` → throws OK / no throw
    - `downloadFile(not exists)` → `ProviderError("NOT_FOUND")`
    - `downloadFile(ifNoneMatch=current)` → `{ notModified: true }`
    - `uploadFile(ifMatch=stale)` → `ProviderError("PRECONDITION_FAILED")`
    - Rate-limit response → `ProviderError("RATE_LIMITED")` with `retryAfterMs`
    - Quota response → `ProviderError("STORAGE_QUOTA_EXCEEDED")` (после F-002)
- [ ] Acceptance: переключение провайдера в тесте не меняет shape failures

## 19.4 Fixture-driven replay test (F-053)

`syncReplayRecorder` пишет события; пока нет теста, что записанный поток воспроизводится через engine.

- [ ] Зафиксировать минимальный `.replay.json` (3 push, 1 pull, 1 conflict) в `tests/fixtures/`
- [ ] Pure-replayer `replaySyncEvents(engine, events)` — проигрывает через mock provider
- [ ] Acceptance: после replay у engine сохраняется такой же финальный state как у источника

## 19.5 .gitignore watcher (F-054)

`workspaceGitignore.ts` сейчас прописывает entry один раз. После rebase / merge / reset запись пропадает → пользователь начинает коммитить `.vscode/vscodesync.json` (или его потомков).

- [x] Pure helper `gitignoreCoexistence.ts`:
  - [x] `detectMissingGitignoreEntries` — report shape с recommendation (insert/repair/none)
  - [x] `buildManagedBlock` / `ensureManagedBlock` — добавление + repair блока
  - [x] Marker-delimited block: `# >>> VSCodeSync managed >>>` ... `# <<< VSCodeSync managed <<<`
- [x] Required entries: `.vscode/vscodesync.json`, `.vscode/vscodesync-local-backup/`, `.vscodesync-quicktransfer/`
- [x] Unit-тесты на 4 сценария — пустой, manual, complete, partial (`tests/unit/gitignoreCoexistence.test.ts`)
- [ ] FileSystemWatcher на `.gitignore` в каждом workspace folder (deferred — UI wiring)
- [ ] При изменении: проверить блок; если нет — silently re-prompt (deferred — UI wiring)
- [ ] Anti-noise: dedup на 5 минут (deferred)

## 19.6 Git worktree + devcontainer awareness (F-055)

- [x] Pure detector `detectWorkspaceContext(input)` → `{ kind, parentRepoPath?, devcontainerImage?, worktreeBranch? }`
- [x] Поддерживает 4 kinds: `normal` / `worktree` / `devcontainer` / `submodule`
- [x] Worktree branch extraction из `.git/HEAD` (`ref: refs/heads/<name>`)
- [x] Devcontainer image extraction из `.devcontainer/devcontainer.json`
- [x] Submodule detection через `.git/modules/` в resolved gitdir
- [x] Unit-тесты на все 4 kinds + branch parsing (`tests/unit/workspaceContextDetector.test.ts`)
- [ ] Workspaces Tree: fold worktrees под parent repo entry (deferred — UI wiring)
- [ ] Badge "in devcontainer" на workspace node (deferred — UI wiring)
- [ ] При attach в devcontainer-env: предупредить о тонкостях (token recovery, secret storage) (deferred)
