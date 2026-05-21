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
- [ ] **B3** `fetch()` без `AbortController` в `gdriveProvider.ts:158`, `onedriveProvider.ts`, `dropboxProvider.ts` — добавить timeout (по аналогии с Yandex `fetchWithTimeout(..., API_TIMEOUT_MS)`). Default 30s, конфигурируется через `vscodesync.providerRequestTimeoutSec`.
- [ ] **B4** `dropboxProvider.downloadFile` (`:233`) — `void options?.ifNoneMatch` буквально игнорирует кэш. Реализовать via Dropbox `Dropbox-API-Arg.rev` сравнение в `getMetadata` (как Yandex), либо явно задокументировать «no 304 на этом провайдере» и кэшировать `(path, rev) → body` локально с TTL.
- [ ] **B5** `watchModePoller` (`watchModePoller.ts`) — если `await runQuietFullSyncAllFolders` бросает, текущий цикл не fail-safe: следующий тик может никогда не запуститься. Завернуть `tick()` в `try/catch` с `warnLog`.
- [ ] **B6** `workspacesTree.refresh()` debounce 150ms + `markPendingDelete()` — гонка между «pending hide» и следующим tree refresh. Гарантировать порядок: `markPendingDelete` → fire → wait next-tick → invalidateRemoteCache.
- [ ] **B7** `fileDecorations.provideFileDecoration()` — стейл `editingBy` в результате. Подключить через `_onDidChangeFileDecorations` к event'у изменения cfg, а не к hash mtime.
- [ ] **B8** `statusBar.formatLastSync` — заменить `toLocaleTimeString()` на явный `formatHm()` чтобы не словить AM/PM в русской локали.
- [ ] **B9** `manifestMerger.mergeManifestFiles` tie-break (`version+updatedAt` равны) — добавить `warnLog` при коллизии, потому что сейчас молча возвращается `a` без сигнала.

## 24.U · UX fixes

- [ ] **U1** `package.json` keybindings — добавить `when: "workspaceFolderCount > 0"` к VSCodeSync-биндингам, чтобы не конфликтовать со встроенными Quick Open / Find.
- [ ] **U2** `package.json` commandPalette — 18 команд с `when: false` пересмотреть: пометить нужные `when: !never` либо вынести в `viewItem` контекст, либо явно скрыть через `vscodesync._isInternalCommand`.
- [ ] **U3** Опасные действия (`deleteWorkspaceFromCloud`, `purgeEncrypted`, `forceDetach`) — 5-секундная undo-подсказка через `withCancellableNotification` (`vscode.window.withProgress` с `cancellable: true`).
- [ ] **U4** Quick-pick «Сменить авто-режим» — биндинг через клик по новому status-bar badge `auto:check / auto:full / auto:off`, без открытия settings.
- [ ] **U5** Tooltips/decorations — единый словарь строк (`src/ui/i18nMessages.ts`) для устранения смешения en/ru.

## 24.F · New features (scope-bounded, wired)

- [ ] **F1 (модное) Smart Pull Digest.** Кнопка/нотификация «Коллеги обновили N файлов с момента последнего открытия» — агрегат с группировкой по машинам, ссылками на diff в hover preview, один клик «Pull всё».
- [ ] **F2 (модное) Cursor-style remote presence chip** в редакторе. Для tracked-файла, который сейчас редактируется на другой машине, поверх textArea показывается тонкая полоска с именем машины и временем последнего ping'а (без блокировки ввода).
- [ ] **F3 Diff-on-hover для `cloud_newer`.** При наведении на файл в дереве — превью diff'а (cloud vs local) во встроенном Webview, без полноценного pull. Re-uses `hoverDiffPreviewProvider`.
- [ ] **F4 Bulk Pull selectively.** Multi-select в дереве: чек-боксы, единое подтверждение, прогресс. Один из основных user-paths сейчас неудобный (по одному).
- [ ] **F5 Auto-mode «adaptive».** Новый режим: `check-only` днём, `full` после 22:00 (или `quiet-hours`). Расширение `autoSyncMode` enum.
- [ ] **F6 Sync rewind.** Точка восстановления workspace по timestamp: «верни всё до 14:30». Re-uses `snapshotsEngine` + `syncReplayRecorder`.
- [ ] **F7 Telegram digest** (если включён в настройках) — раз в день: что-кто-сколько запушил. Re-uses webhook adapter из v0.6.
- [ ] **F8 Команда «Соберись и иди»** — pre-flight перед закрытием ноутбука: пушнуть всё, проверить что нет конфликтов, показать «можно закрывать» / «есть N изменений, разрешите?». Палитра + статус-bar item.

## 24.X · Wiring deferred

- [ ] **X1** `D01` provider hash verify — расширить на `pullFile` (сейчас только push).
- [ ] **X2** `D06` Trusted teammates — UI для добавления через QR-код / share-link.
- [ ] **X3** Phase 17 (Finish underbaked) WebRTC P2P signaling — раз и навсегда завершить hand-shake round-trip с реальным провайдером сигналинга или явно убрать в `v2.5`.

## 24.M · Modern bonus (без явного user-ask)

- [ ] **M1** Content-defined chunking (CDC) для blob'ов >1 MB. Дедупликация общих кусков между файлами/версиями. Backend-агностично.
- [ ] **M2** Generic S3 provider (MinIO/Wasabi/AWS) через `aws-sdk-v3` lite. Закроет enterprise use-case.
- [ ] **M3** BLAKE3 on the write-path. Уже в schema (`hashBlake3` в `MetaEntry`), но не активирован. Добавить setting `vscodesync.canonicalHashAlgo: "sha256" | "blake3" | "dual"` (default `dual` пока не мигрировали все).
- [ ] **M4** WebAuthn passkey-only режим — без OAuth refresh tokens. Уменьшение surface area.
- [ ] **M5** GitHub Releases as provider (experimental) — для снапшотов / архивов.

## 24.D · Docs

- [ ] **D1** `audit-findings.md` (этот же каталог) — полные результаты трёх аудит-агентов с file:line, для будущих ревью.
- [ ] **D2** `docs/continuity.md` — добавить раздел «Race conditions: что мы выучили в 2026-05-21».
- [ ] **D3** README: обновить раздел «Auto-sync modes» — добавить визуал нового status-bar badge.

---

## Honest scope note

Phase 23 заканчивалась тезисом «codebase is feature-complete for v1».
Этот тезис сохраняется по сути: scope текущей фазы — **починка**
(24.A/B/U) и **новый user-visible полезный layer** (24.F), а не
inflating helper-count.

24.M (modern bonus) — кандидаты в v2, не блокируют выпуск 24.

«Stop adding helpers if there's no wiring» — соблюдается:
F1–F8 все имеют конкретный UX, не pure helpers.
