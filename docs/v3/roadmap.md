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
- [ ] Setting `vscodesync.selectiveSync.mode`: `"all-tracked"` (default — текущее) | `"include-list"` | `"exclude-list"`.
- [ ] Per-workspace файл `.vscodesync-include` (gitignore-синтаксис) — workspaceConfig.files фильтруется по нему перед push.
- [ ] UI команда `vscodesync.selectiveSyncEditList` — open `.vscodesync-include` с template и подсветкой.
- [ ] Diff-preview: «эти файлы перестанут синкаться при сохранении» с возможностью отмены.

**Риск:** добавление exclude может «потерять» файл на других машинах (его удалят как stale). Нужен safeguard: пред-удаление warning + grace period.

---

## B. Cost & quota dashboard

**Зачем:** все 5 провайдеров имеют API quotas. Сейчас `syncRateLimitState`
наблюдает 429-ответы post-fact. Хотелось бы proactive view: «вы потратили
~3000 OneDrive API calls за день, лимит 10000».

**Что:**
- [ ] Pure helper `src/core/quotaTracker.ts` — счётчик per-provider per-window (rolling 24 ч).
- [ ] Hook в `queuedProvider.ts` — каждый API call инкрементирует счётчик.
- [ ] UI команда `vscodesync.showQuotaDashboard` — webview с per-provider графиками (использовать существующий `sparkline` или CSS-grid bars).
- [ ] Alerts: при 70% / 90% от известного лимита → warning. При 95% → auto-pause sync на 1 час.
- [ ] Per-provider known limits: уже частично есть в `PROVIDER_RATE_LIMITS` — расширить дневными лимитами (Google Drive: 1B reads/day, etc.).

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
- [ ] Pure planner `src/core/keyRotationPlan.ts` — для каждого workspace, для каждого encrypted file: planRotation(oldKey, newKey) → batches.
- [ ] UI команда `vscodesync.rotateEncryptionKey` — modal warning → progress bar → вкл./выкл. workspace temporarily.
- [ ] Resumable: если прервалось — `_meta.json` хранит флаг `rotationInProgress: { from: keyId, to: keyId, completed: rels[] }`. Re-run продолжает с того же места.
- [ ] Multi-machine sync of new key: write encrypted-with-old-pwd-protected blob `_keyrotation/{rotationId}.json` чтобы другие машины подхватили.

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
- [ ] Pure planner `src/core/syncSchedulePlanner.ts` — расширение существующего `snapshotSchedule` parser: поддержать cron-like syntax + time windows.
- [ ] Setting `vscodesync.syncSchedule`: `"daily 09:00,12:00,18:00"` или `"workhours 30m"` (каждые 30 мин в 9–18 будни) или `"hourly"`.
- [ ] Hook через тот же polling в `scheduledSnapshots.ts`.

---

## G. Diff-merge UI improvements (visual 3-way merger)

**Зачем:** сейчас при конфликте — `<<<<<<<` маркеры в файле + `vscode.diff`
3-way. Хочется webview с side-by-side panes (base | local | cloud | merged)
с per-hunk переключателями.

**Что:**
- [ ] Webview `src/ui/visualMergerPanel.ts` — 4 панели, кнопки `[← keep mine] [keep theirs →]` per-hunk, AI-merge для каждого hunk опционально.
- [ ] Pure planner `src/core/visualMergePlan.ts` — diff alignment, hunk extraction, applyHunkChoices.
- [ ] Команда `vscodesync.openVisualMerger` (при наличии активного conflict).

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
- [ ] Pure helper `src/core/shareLink.ts` — generate signed URL `vscode://borodatych.vscodesyncfiles/share?workspace=...&snapshot=...&pwd=hash`.
- [ ] При open ссылки на другой машине — invitee получает read-only access, может скачать snapshot, но не push'ить.
- [ ] Storage: ACL field в snapshot meta — `sharedTo: { hashedPwd, expiresAt, readOnly: true }`.

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
- [ ] Pure helper `src/core/autoPauseLearner.ts` — анализ activity log за 30 дней, кластеризация по hour-of-day → классификация «active hours» / «quiet hours».
- [ ] Auto-pause во время quiet hours (но manual sync доступен).
- [ ] Setting `vscodesync.autoPause.learnedSchedule.enabled` (opt-in).

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
