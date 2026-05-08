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
- [x] Resumable: `MetaJson.rotationInProgress: { fromKeyId, toKeyId, completed[], startedAt, initiatedByMachineId }` объявлен в `cloudLayout.ts`. Forward-compat — старые readers игнорируют.
- [x] Multi-machine key sync transport — `src/core/keyRotationTransport.ts` определяет `KeyRotationTransportEnvelope` shape (v=1, rotationId, fromKeyId, toKeyId, createdAt, encryptedBlobB64+ivB64+authTagB64). `buildKeyRotationTransport()` + `decodeKeyRotationTransport()` strict-decoder с stale-rejection (default 30 days). `cloudPathForKeyRotation(rotationId)` возвращает `_keyrotation/{id}.json`. 9 unit-тестов. Engine wiring (вычитка envelope при старте machine, расшифровка через old KEK, swap SecretStorage) — следующая итерация.

---

## E. Workspace import from git

**Зачем:** ускоренный onboarding: «у меня репо github.com/me/dotfiles, хочу
синхронизировать его как VSCodeSync workspace». Сейчас — manual: clone, open,
add files один за другим.

**Что:**
- [x] Pure planner `src/core/gitImportPlanner.ts` — `planGitImport(.gitignoreContent)` парсит .gitignore, отделяет patterns / comments / unsupported negations. `renderVscodesyncIgnore(plan)` рендерит готовый файл с header+notes. 5 unit-тестов.
- [x] Pure step planner `src/core/gitImportFromUrl.ts` — `parseRepoUrl(url)` (HTTPS / SSH формы, host/owner/repo extraction) + `planImportFromGit({ url, targetFolderAbs })` возвращает 8 ordered steps (validate_url → ensure_target_folder → git_clone → read_gitignore → translate → scan_files → create_workspace → add_files). 9 unit-тестов.
- [ ] CLI команда `vscodesync init from-git` — skeleton (planner ready, нужен `child_process.spawn` для git clone и обвязка над workspace API).
- [ ] VS Code команда `vscodesync.initFromGit` — skeleton.
- [ ] Sync git HEAD при push — skeleton (pure helper в `gitHeadCompare.ts` ready, engine hook не сделан).

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
- [x] Pure helper `src/core/aiBulkReviewPrompt.ts` — `buildBulkReviewPrompt(input)` и `buildBulkReviewBatchPrompt(inputs)` строят LM-промпт; `parseBulkReviewVerdict(rawResponse, relPath)` строгий парсер JSON-ответа; `summariseBulkReview(verdicts)` сводка с buckets high/medium/low + `needsAttention`. 9 unit-тестов.
- [ ] UI в `bulkPushWizard` (skeleton — pure builder/parser ready).

---

## I. Backup verification

**Зачем:** `crossCloudBackup` пишет в secondary провайдер, но никогда не
проверяет целостность. Backup без verify ≠ backup.

**Что:**
- [x] Pure planner `src/core/backupVerifyPlanner.ts` — `planBackupVerify(workspaceId, primary[], secondary[], { freshnessSlackMs? })` возвращает per-entry mismatches (`missing_in_secondary` / `hash_mismatch` / `stale_in_secondary` / `extra_in_secondary`) + `consistent` flag. `scoreVerifyReport(r)` severity ladder (ok/drift/stale/broken). 9 unit-тестов.
- [ ] Engine background job (skeleton — engine wiring к scheduler).
- [ ] Команда `vscodesync.verifyBackup` (skeleton).
- [ ] Restore-test (skeleton — engine wiring).

---

## J. Per-folder strategy

**Зачем:** workspace может содержать папки с разной chesterчувствительностью. `node_modules/` — never sync, `src/` — cloud + P2P, `secrets/` — P2P-only (не на облако), `.vscode/` — local-only.

**Что:**
- [x] Конфиг-файл `.vscodesync-strategy` parser в `src/core/perFolderSyncStrategy.ts` — `parseStrategyFile(text)` + `resolveStrategy(relPath, rules)`. Strategies: `never | local-only | p2p-only | cloud`. First-matching-rule-wins, default fallback `cloud`. 8 unit-тестов.
- [ ] Hook в `pushFile` / `pullFile` (skeleton — нужна обвязка к engine).
- [ ] UI команда `vscodesync.editStrategy` — skeleton (открыть файл template).

---

## K. Public sharing links

**Зачем:** «отправь коллеге ссылку на read-only снэпшот моего workspace».

**Что:**
- [x] Pure helper `src/core/shareLink.ts` — `buildShareLink({ workspaceId, snapshotName, expiresAtMs?, passwordHashHex? })` + `parseShareLink(raw, now?)` с проверками expired/wrong_path/bad_field. 5 unit-тестов.
- [ ] При open ссылки на другой машине — invitee получает read-only access (skeleton — обвязка `vscode.window.registerUriHandler` остаётся).
- [x] Storage: ACL field `SnapshotMeta.sharedTo: SnapshotShareACL = { hashedPwdHex, expiresAtIso, readOnly: true }` объявлен в `cloudLayout.ts`. `verifySnapshotShareACL(acl, providedPwdHashHex, now)` в `shareLink.ts` для server-side проверки (constant-time compare + TTL). 7 unit-тестов. Engine-side enforcement в push/pull путях остаётся следующей итерацией.

**Риск:** создаёт «sharing» которого раньше не было. Можно вызвать confusion. Подумать: нужно ли это вообще, или достаточно «share via cloud provider's native share».

---

## L. Workspace-level git history sync

**Зачем:** часто workspace = git repo. Хочется синхронизировать не только файлы, но и git state (текущий branch, pending commits) между машинами.

**Что:**
- [x] Track `gitBranch` в `_meta.json` — уже есть.
- [x] Pure helper `src/core/gitHeadCompare.ts` — `parseGitHead(content)` (branch / detached / unparseable) + `compareGitBranches(localHead, cloudBranch)` с verdicts (match / diverged / local_detached / cloud_unset / local_unparseable) + `describeBranchVerdict(v)` для toast. 9 unit-тестов.
- [ ] Опциональный `git fetch` после pull (skeleton — engine hook).

---

## M. Smart auto-pause learning

**Зачем:** sync во время AFK / lunch time бесполезен. Хочется «расширение
выучило когда я работаю».

**Что:**
- [x] Pure helper `src/core/autoPauseLearner.ts` — `learnAutoPauseSchedule(timestamps, { quietHourRatio?, minEvents?, timezoneOffsetMinutes? })` возвращает 24-element `hourActive[]` + counts + mean. `isQuietHour(schedule, nowMs)` для runtime check. 3 unit-теста.
- [ ] Auto-pause во время quiet hours (skeleton — нужен hook в `queuedProvider`).
- [x] Setting `vscodesync.autoPause.learnedSchedule.enabled` объявлен в `package.json` + en/ru NLS. Engine hook остаётся (нужен `queuedProvider` integration).

---

## N. Workspace replay viewer

**Зачем:** для debugging — «что произошло вчера в 14:00, почему файл откатился?».
Replay-recorder уже есть (запись), но нет viewer'а.

**Что:**
- [ ] Webview `src/ui/syncReplayViewerPanel.ts` — skeleton (pure playback ready, render deferred).
- [x] Pure helper `src/core/syncReplayPlayback.ts` — `makeReplayCursor`, `stepReplayCursor`, `seekReplayByTime` (binary search), `filterReplayEvents` (kind / file / machine), `eventsToReleasePerTick(rate, elapsedMs, carry)` для адаптивного playback. 13 unit-тестов.
- [ ] Команда `vscodesync.openSyncReplayViewer` (skeleton).

---

## Anti-recommendations (что НЕ делать) — продолжение

В дополнение к anti-recs из v2/roadmap.md:

- **Полноценный server-mode (без облачных провайдеров)** — нарушает «нет наших серверов».
- **VSCode Insiders Live Share API integration** — это другой продукт; не наш scope.
- **Свой sync protocol поверх существующих cloud APIs** — пере-инжиниринг; provider primitives хватает.
- **Auto-rebase merge strategy** — too aggressive для desktop sync; пользователь должен явно подтвердить разрешение.
- **Прозрачная encryption-key rotation без подтверждения** — если rotation прервётся без grace period, пользователь потеряет доступ к данным. Всегда явный wizard.
