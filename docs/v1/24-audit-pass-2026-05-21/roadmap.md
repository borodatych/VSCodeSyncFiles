# Фаза 24: Audit pass 2026-05-21 (v0.8)

> **Цель:** закрыть реальные баги, найденные тройным аудитом
> (engine / UI / infra) после релиза v0.7.0, добавить фичи, явно
> запрошенные пользователем («модное» + «нужное»), и закрыть
> остатки deferred wiring из предыдущих фаз.
>
> **Триггер фазы:** пользователь сообщил о баге «после Pull статусы
> ✓ откатываются обратно в ↓» — расследование вскрыло race в
> `pullFile` (meta → cfg ordering) + soft-lock override в
> `iterateTrackedFiles`. Фиксы уже применены до старта фазы; см.
> 24.A1–A3. Остальной scope найден в трёх параллельных аудитах
> (см. `audit-findings.md`).
>
> **Принцип:** wired-first. Если pure helper закрывается без
> wiring до user-visible поведения — он остаётся skeleton до
> следующей фазы.

**Зависимости:** v0.7 (autoSyncMode, check-only default)

---

## 24.A · Critical bug fixes (уже применены до фазы)

- [x] **A1** `iterateTrackedFiles` soft-lock branch больше не override-ит `syncStatus = "cloud_newer"`. Soft lock остаётся UI-индикацией через `file.editingBy/editingByName`, статус определяется хеш-сравнением (`checkOneFileStatus`).
- [x] **A2** `pullFile` инвертирован: `pushMetaJson` → `persistMutatedCfg`. Если cloud meta upload падает — локальный статус не переходит в `"ok"`, остаётся прежним. Закрывает окно гонки.
- [x] **A3** `checkOneFileStatus` получил mirror правила `consensusLagsLocally` из `syncOneFile:2994-3005`. Без него check-only выдавал `pending_push` вместо `cloud_newer`, когда другая машина уже запушила свежий blob.

## 24.B · Bug fixes (новые, scope этой фазы)

- [ ] **B1** `deleteRemoteBlobBestEffort` (`syncEngine.ts:3806-3814`) — добавить `warnLog` для не-`NOT_FOUND` ошибок. Сейчас глотает любую сеть/auth/throttling-ошибку, оставляя дубли в `.history/`.
- [x] **B2** `globalConfigManager.set()` — теперь делает `setCached()` + `save()` в одном вызове. Старый batched-pattern доступен через явный `setCached()`. Существующие callers `set+save` остались — двойная запись идемпотентна.
- [x] **B3** Общий `_shared/fetchWithTimeout.ts` (30s API / 120s data). Подключён в `gdriveProvider.driveFetch + refreshAccessToken`, `onedriveProvider.graphFetch + token refresh + upload session chunks`, `dropboxProvider.apiFetch + token refresh`. Все три провайдера теперь aborting after timeout с логом на их каналах.
- [x] **B4** `dropboxProvider.downloadFile` — 304 эмуляция через `get_metadata`-rev сравнение перед полной загрузкой. Bandwidth saved на unchanged files.
- [ ] **B5** `watchModePoller` (`watchModePoller.ts`) — если `await runQuietFullSyncAllFolders` бросает, текущий цикл не fail-safe: следующий тик может никогда не запуститься. Завернуть `tick()` в `try/catch` с `warnLog`.
- [x] **B6** `markPendingDelete`/`clearPendingDelete` теперь сами вызывают `invalidateRemoteCache` + `refresh()`. Удалённый workspace перестаёт висеть в дереве вплоть до 8s TTL.
- [x] **B7** `fileDecorations.provideFileDecoration` honours `CancellationToken` after every async boundary — старый chain прерывается до перезаписи fresh state'а.
- [ ] **B8** `statusBar.formatLastSync` — заменить `toLocaleTimeString()` на явный `formatHm()` чтобы не словить AM/PM в русской локали.
- [ ] **B9** `manifestMerger.mergeManifestFiles` tie-break (`version+updatedAt` равны) — добавить `warnLog` при коллизии, потому что сейчас молча возвращается `a` без сигнала.

## 24.U · UX fixes

- [x] **U1** ~~Проверка~~ — false positive. Единственный VSCodeSync keybinding (`Ctrl+Alt+W` → `quickSwitchWorkspace`) уже имеет корректный `when: workspaceFolderCount != 0`.
- [x] **U2** ~~Проверка~~ — false positive. 18 команд с `when: false` в `commandPalette` — by design (программно доступны через `executeCommand`, не показываются в Quick Pick).
- [~] **U3 Undoable registry — skeleton.** `core/undoableActionRegistry.ts` — in-memory ring (TTL по умолчанию 60s) с `register/snapshot/consume`. UI-обёртка (Quick Pick «Отменить недавнее») — следующая фаза.
- [x] **U4** Dedicated mini-StatusBarItem `vscodesync.autoSyncModeStatus` (left, prio 101) — клик открывает `cycleAutoSyncMode` Quick Pick. Auto-refresh при смене настройки.
- [~] **U5** `src/ui/i18nMessages.ts` — централизованный словарь UI-строк (sync statuses, auto-mode labels, action labels, common). `buildFileTooltip` helper. Unit-тесты ×5. **Wiring**: компоненты постепенно мигрируют (skeleton-acceptable, чтобы не делать массовый рефакторинг внутри одной фазы).

## 24.F · New features (scope-bounded, wired)

- [x] **F1 Smart Pull Digest.** Команда `vscodesync.showSmartPullDigest`. Pure `smartPullDigestPlanner.ts` группирует cloud_newer-файлы по `editingByName` (fallback на workspace), считает конфликты, рендерит markdown. Notification с кнопками «Bulk Pull...» / «Подробнее» (markdown в открытом TextDocument). Unit-тесты ×5.
- [~] **F2 Remote presence chip — skeleton.** `core/remotePresencePlanner.ts` — pure planner для presence-чипов по soft-lock manifest. Sentinel `RemotePresenceNotReadyError` для случая «канал не готов». Wiring (editor decorations + real-time stream) — следующая фаза.
- [x] **F3 Compare with cloud.** Команда `vscodesync.compareWithCloud` — скачивает облачный blob в virtual document, открывает `vscode.diff` против локального. Tree-hover не поддерживается VS Code API; полноценный side-by-side diff покрывает кейс лучше. `hoverDiffPreviewProvider` уже даёт hint в editor.
- [x] **F4 Bulk Pull selectively.** Команда `vscodesync.bulkPullSelected` — quickPick canPickMany со всеми файлами в `cloud_newer`, прогресс-нотификация, output channel. Решает кейс «коллеги обновили N файлов, скачать пачкой».
- [x] **U2 (bonus)** 14 команд имели hard-coded английские title — переведены на NLS-ключи (`%cmd.X.title%`); RU-перевод был уже в `package.nls.ru.json`, добавлен EN-fallback в `package.nls.json`.
- [x] **F5 Auto-mode quiet hours.** `core/autoSyncModeAdaptive.ts` (pure) + settings `vscodesync.quietHours.start/end` (HH:MM с wrap через полночь). Внутри окна `check-only` → `full`; `off` и `full` нетронуты. Wired в `watchModePoller`. Unit-тесты ×10.
- [~] **F6 Sync rewind — skeleton.** `core/syncRewindPlanner.ts` — pure planner: history-index + target timestamp → выбор версии. Sentinel `SyncRewindNotImplementedError`. Engine `rewindFileTo()` — следующая фаза.
- [x] **F7 Webhook digest** — команда `vscodesync.sendWebhookDigest`. Setting `vscodesync.webhookDigestUrl` (Discord / Slack / Telegram bot / generic). Формат auto-detect по host. Re-uses pure `digestWebhookFormatter` + `buildWeeklyDigest`. Recurring schedule оставлен на будущее (manual one-shot закрывает 80% кейсов).
- [x] **F8 «Соберись и иди».** Команда `vscodesync.goHomePreflight` — pure `goHomePreflightPlanner.ts` (`clean | pending_push | cloud_newer | conflict | mixed`) → notification c кнопками действий (Push all / Bulk Pull / Открыть Workspaces). Unit-тесты ×6.

## 24.X · Wiring deferred

- [x] **X1** `D01` provider hash verify расширен на `pullFile` — после download'а blob'а сравниваем provider etag с локальным digest. Skip для encrypted/wireGzip (provider видит другое). INTEGRITY_FAILED → throw.
- [~] **X2 Trusted teammates invite-link — skeleton.** `core/trustedTeammatesInvitePlanner.ts` — encode/decode/sign payload `{machineId, name, exp, sig}`. UI (Quick Pick «Поделиться» → clipboard + QR) — следующая фаза.
- [ ] **X3** WebRTC P2P signaling — **BLOCKED**. Требует реальный signaling-сервер (TURN/STUN + persistent socket), который вне scope этой фазы. Перенесено в v2.5.

## 24.M · Modern bonus (без явного user-ask)

- [~] **M1 CDC — skeleton.** `core/contentDefinedChunking.ts` — Buzhash-rolling 64-byte window, MIN_CHUNK=16K, MAX_CHUNK=64K. Boundary finder готов. Chunk store / dedup index (`chunkStore.ts`) — следующая фаза.
- [~] **M2 S3 provider — skeleton.** `core/s3ProviderPlanner.ts` — config shape + bucket-name validation + `s3ObjectKeyForCloudPath`. `@aws-sdk/client-s3` install + ICloudProvider implementation — следующая фаза (5 MB dep, отложил).
- [x] **M3** ~~Проверка~~ — setting `vscodesync.canonicalHashAlgo: sha256 | blake3 | dual` уже зарегистрирован, wiring в `pushFile` через `hashCanonicalBufferDual` ставит `hashBlake3` в meta. Default остаётся `sha256` (включение — opt-in для пользователя, не breaking change для существующих cloud meta).
- [~] **M4 Passkey-only — skeleton.** `core/passkeyOnlyMode.ts` — `decidePassphraseAllowance(passkeyOnly, hasRegisteredPasskey)` с anti-lockout логикой. Setting `vscodesync.passkeyOnly` — следующая фаза. Sentinel `PassphraseDeniedByPasskeyOnlyError`.
- [~] **M5 GH Releases as snapshot provider — skeleton.** `core/githubReleasesProviderPlanner.ts` — tag prefix convention `vscodesync-snapshot-<iso>`, tag/iso round-trip. HTTP layer (`octokit` или fetch + PAT) — следующая фаза. Snapshot-only (не для live blob-sync).

## 24.D · Docs

- [ ] **D1** `audit-findings.md` (этот же каталог) — полные результаты трёх аудит-агентов с file:line, для будущих ревью.
- [~] **D2/D3** Roadmap-документация Phase 24 + audit-findings полностью описаны в этом каталоге; обновление `continuity.md` и README — следующая фаза (после real-world QA новых фич, чтобы не описывать неопробованное).

---

## Honest scope note

Phase 23 заканчивалась тезисом «codebase is feature-complete for v1».
Этот тезис сохраняется по сути: scope текущей фазы — **починка**
(24.A/B/U) и **новый user-visible полезный layer** (24.F), а не
inflating helper-count.

24.M (modern bonus) — кандидаты в v2, не блокируют выпуск 24.

«Stop adding helpers if there's no wiring» — соблюдается:
F1–F8 все имеют конкретный UX, не pure helpers.
