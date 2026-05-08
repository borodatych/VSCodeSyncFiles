# VSCodeSync v3 — следующие направления

> v1 закрыт, v2 расписан в [v2/breakdown.md](../v2/breakdown.md). v3 — новые
> темы, выходящие за рамки текущей архитектуры. Каждый раздел — кандидат
> на `XL`-планёрку. Здесь зафиксированы цели + первичная декомпозиция.
>
> **Принципы выбора:** держим обещание «нет наших серверов», «только ваше
> облако», «IDE-first». Идеи, которые ломают это — в anti-recommendations
> v2 (см. там).

---

## A. Selective sync — частичный workspace на cloud

**Зачем:** в реальных проектах часть файлов public (sync OK), часть private
(secrets, локальные конфиги, build artifacts). Сейчас VSCodeSync — all-or-nothing
per-file. Хочется per-file include/exclude по паттернам с инвертированной логикой.

**Что:**
- [~] Setting `vscodesync.selectiveSync.mode` — pure helper готов; обвязка к `package.json` и `pushFile`/`pullFile` остаётся.
- [x] Pure filter `src/core/selectiveSyncFilter.ts`: `evaluateSelectiveSync(relPath, { mode, patterns })` + `parseSelectiveSyncFile(text)`. Поддержка `*` / `**` / `?` / trailing slash для директорий. 5 unit-тестов.
- [ ] UI команда `vscodesync.selectiveSyncEditList` — открыть `.vscodesync-include` с template (skeleton).
- [ ] Diff-preview перед удалением (skeleton — нужен engine hook).

**Риск:** добавление exclude может «потерять» файл на других машинах (его удалят как stale). Нужен safeguard: пред-удаление warning + grace period.

---

## B. Cost & quota dashboard

**Зачем:** все 5 провайдеров имеют API quotas. Сейчас `syncRateLimitState`
наблюдает 429-ответы post-fact. Хотелось бы proactive view: «вы потратили
~3000 OneDrive API calls за день, лимит 10000».

**Что:**
- [x] Pure helper `src/core/quotaTracker.ts` — `createQuotaTracker({ windowMs?, overrideLimits? })` с `recordCall / snapshot / snapshotAll`. Severity ladder (`ok` / `warning` ≥70% / `critical` ≥90% / `auto_pause` ≥95%). 5 unit-тестов.
- [ ] Hook в `queuedProvider.ts` — обвязка для инкремента (skeleton; нужно прокинуть tracker через DI).
- [ ] UI команда `vscodesync.showQuotaDashboard` — webview (skeleton).
- [x] Severity ladder реализован — alerts генерируются вызывающей стороной по `severity`.
- [x] Per-provider limits в `PROVIDER_DAILY_LIMITS` (gdrive: 1B; остальные null = unknown).

---

## C. Multi-account per provider

**Зачем:** текущая архитектура — один OneDrive аккаунт на инсталляцию. Хочется:
work account для рабочего workspace, personal для личного.

**Что:**
- [ ] Расширить `globalConfig`: `providers: { onedrive: AccountSlot[]; gdrive: AccountSlot[]; ... }` где `AccountSlot = { id, displayName, tokens }`.
- [ ] Per-workspace сохранение: какой `accountSlot.id` использовать.
- [ ] Migration: существующие single-account configs → переехать в `accounts[0]`, default workspace → `accounts[0]`.
- [ ] UI: `vscodesync.addProviderAccount`, picker аккаунтов в `connectCloudWorkspace`.

**Риск:** OAuth flow для нескольких аккаунтов одного провайдера — придётся signOut + signIn последовательно (одна машина не может быть logged-in в Google Drive под двумя аккаунтами одновременно из CLI). Решение: отдельный `tokenStore[accountId]`, использовать выбранный токен per-request.

---

## D. Encryption key rotation wizard

**Зачем:** пользователь скомпрометировал ключ или просто хочет ротировать.
Сейчас change-key — manual + lossy: придётся скачать всё, перезашифровать
старым→новым ключом, загрузить.

**Что:**
- [x] Pure planner `src/core/keyRotationPlan.ts` — `planKeyRotation(items, { maxBytesPerBatch?, maxFilesPerBatch? })` с детерминированной сортировкой `(workspaceId, relPath)` и пропуском `done: true`. 3 unit-теста.
- [ ] UI команда `vscodesync.rotateEncryptionKey` (skeleton — пока зарегистрирована в `package.json`, привязка к engine остаётся).
- [ ] Resumable: caller персистит `done` флаг в `_meta.json.rotationInProgress` — supported by planner shape.
- [ ] Multi-machine key sync через `_keyrotation/{rotationId}.json` (skeleton).

---

## E. Workspace import from git

**Зачем:** ускоренный onboarding: «у меня репо github.com/me/dotfiles, хочу
синхронизировать его как VSCodeSync workspace». Сейчас — manual: clone, open,
add files один за другим.

**Что:**
- [ ] CLI команда `vscodesync init from-git <repo-url> [--folder ...]` — clone репо в указанную папку, создать workspace, добавить все файлы (с применением `.gitignore` как `.vscodesync-ignore`).
- [ ] VS Code команда `vscodesync.initFromGit` — same flow через QuickPick + showOpenDialog.
- [ ] Sync git HEAD: при push на VSCodeSync делать также `git push` (опционально, через setting).

---

## F. Sync-by-time scheduler

**Зачем:** сейчас `scheduledSnapshots` cover snapshots, но не full sync.
Полезно: «sync каждые 4 часа в рабочее время, тише ночью».

**Что:**
- [x] Pure planner `src/core/syncSchedulePlanner.ts` — `parseSyncSchedule(raw)` поддерживает `hourly` / `daily HH:MM[,HH:MM]*` / `weekly <day> HH:MM` / `workhours Nm`. `isSyncDueAt(schedule, lastRunMs, nowMs)` для polling. 11 unit-тестов.
- [x] Setting `vscodesync.syncScheduleExtended` (отдельная от существующего `snapshotSchedule`) + en/ru NLS.
- [ ] Hook через polling в `scheduledSnapshots.ts` (skeleton — engine-side wiring).

---

## G. Diff-merge UI improvements (visual 3-way merger)

**Зачем:** сейчас при конфликте — `<<<<<<<` маркеры в файле + `vscode.diff`
3-way. Хочется webview с side-by-side panes (base | local | cloud | merged)
с per-hunk переключателями.

**Что:**
- [ ] Webview `src/ui/visualMergerPanel.ts` (skeleton — pure planner ready, UI рендер deferred).
- [x] Pure planner `src/core/visualMergePlan.ts` — `buildMergePlan(base, local, cloud)` возвращает `{ hunks, conflictCount }` (kinds: clean / conflict / addition_local|cloud / deletion_local|cloud). `applyHunkChoices(hunks, choices, customMerged?)` материализует результат. 8 unit-тестов.
- [ ] Команда `vscodesync.openVisualMerger` — skeleton (pure planner ready).

**Риск:** дублирует существующий VS Code merge editor (Insiders). Возможно стоит проверить — если `vscode.openMergeEditor` API доступен → использовать его.

---

## H. AI reviewer for big merges

**Зачем:** при large bulk-pull можно случайно overwrite важные локальные изменения.
AI-review summary каждого файла перед apply.

**Что:**
- [ ] Pure helper `src/core/aiBulkReviewPrompt.ts` — для каждого файла builds prompt: `{ relPath, localContent, cloudContent }` → `vscode.lm` summary «cloud version изменяет: A, B, C; локальная версия изменяет: D». Возвращает risk score + human-readable summary.
- [ ] UI in `bulkPushWizard` (extension): при > 10 файлов → optional AI-review pass.

---

## I. Backup verification

**Зачем:** `crossCloudBackup` пишет в secondary провайдер, но никогда не
проверяет целостность. Backup без verify ≠ backup.

**Что:**
- [ ] Background job (раз в неделю): для случайного workspace — download manifest из secondary, compare с primary. Mismatch → alert.
- [ ] Команда `vscodesync.verifyBackup` — manual full check для всех workspace.
- [ ] Restore-test: для каждого snapshot в backup — temp restore в `_verify/`, проверить hash совпадает с `_meta.json`, удалить.

---

## J. Per-folder strategy

**Зачем:** workspace может содержать папки с разной chesterчувствительностью. `node_modules/` — never sync, `src/` — cloud + P2P, `secrets/` — P2P-only (не на облако), `.vscode/` — local-only.

**Что:**
- [ ] Конфиг-файл `.vscodesync-strategy` (gitignore-синтаксис + per-pattern strategy):
  ```
  node_modules/   never
  secrets/        p2p-only
  .vscode/        local-only
  *               cloud
  ```
- [ ] Hook в `pushFile` / `pullFile`: respect strategy.
- [ ] UI команда `vscodesync.editStrategy` — открыть файл с template.

---

## K. Public sharing links

**Зачем:** «отправь коллеге ссылку на read-only снэпшот моего workspace».

**Что:**
- [x] Pure helper `src/core/shareLink.ts` — `buildShareLink({ workspaceId, snapshotName, expiresAtMs?, passwordHashHex? })` + `parseShareLink(raw, now?)` с проверками expired/wrong_path/bad_field. 5 unit-тестов.
- [ ] При open ссылки на другой машине — invitee получает read-only access (skeleton — обвязка `vscode.window.registerUriHandler` остаётся).
- [ ] Storage: ACL field в snapshot meta — `sharedTo: { hashedPwd, expiresAt, readOnly: true }` (skeleton).

**Риск:** создаёт «sharing» которого раньше не было. Можно вызвать confusion. Подумать: нужно ли это вообще, или достаточно «share via cloud provider's native share».

---

## L. Workspace-level git history sync

**Зачем:** часто workspace = git repo. Хочется синхронизировать не только файлы, но и git state (текущий branch, pending commits) между машинами.

**Что:**
- [ ] Track `gitBranch` в `_meta.json` (уже есть).
- [ ] При sync — read local `.git/HEAD`, compare с `_meta.json.gitBranch`. Mismatch → toast «локальная ветка `feature/x`, на машине alpha — `main`. Switch?».
- [ ] Опционально: автоматически делать `git fetch` после pull (без `git checkout` — пользователь сам решает).

---

## M. Smart auto-pause learning

**Зачем:** sync во время AFK / lunch time бесполезен. Хочется «расширение
выучило когда я работаю».

**Что:**
- [x] Pure helper `src/core/autoPauseLearner.ts` — `learnAutoPauseSchedule(timestamps, { quietHourRatio?, minEvents?, timezoneOffsetMinutes? })` возвращает 24-element `hourActive[]` + counts + mean. `isQuietHour(schedule, nowMs)` для runtime check. 3 unit-теста.
- [ ] Auto-pause во время quiet hours (skeleton — нужен hook в `queuedProvider`).
- [ ] Setting `vscodesync.autoPause.learnedSchedule.enabled` (skeleton).

---

## N. Workspace replay viewer

**Зачем:** для debugging — «что произошло вчера в 14:00, почему файл откатился?».
Replay-recorder уже есть (запись), но нет viewer'а.

**Что:**
- [ ] Webview `src/ui/syncReplayViewerPanel.ts` — timeline с per-event markers, filter по kind / file / machine, step-by-step playback.
- [ ] Pure helper `src/core/syncReplayPlayback.ts` — позиционирование по timestamp, seek, играть N events / sec.
- [ ] Команда `vscodesync.openSyncReplayViewer` → load `replay-{uuid}.json` → render.

---

## Anti-recommendations (что НЕ делать) — продолжение

В дополнение к anti-recs из v2/roadmap.md:

- **Полноценный server-mode (без облачных провайдеров)** — нарушает «нет наших серверов».
- **VSCode Insiders Live Share API integration** — это другой продукт; не наш scope.
- **Свой sync protocol поверх существующих cloud APIs** — пере-инжиниринг; provider primitives хватает.
- **Auto-rebase merge strategy** — too aggressive для desktop sync; пользователь должен явно подтвердить разрешение.
- **Прозрачная encryption-key rotation без подтверждения** — если rotation прервётся без grace period, пользователь потеряет доступ к данным. Всегда явный wizard.
