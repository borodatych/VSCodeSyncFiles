# Фаза 22: Modern Features (v0.16)

> **Цель:** 15 новых pure-helpers, каждый закрывает реальный gap или приносит features, ожидаемые от современных IDE-расширений 2026. Все unit-тестированы. UI wiring — отдельная волна.

**Зависимости:** v0.15 (Phase 21 wiring) для некоторых ssm-style elements
**Это последняя фаза v1 в обозримом будущем.**

---

## 22.1 N01 — SCM-style Source Control Integration

- [x] Pure grouper `groupTrackedFilesForScm` — bucketise по syncStatus + editingBy
- [x] 5 buckets: `conflict | pending_push | cloud_newer | soft_locked | ok_recent`
- [x] Severity mapping (error/warn/info/ok)
- [x] Unit-тесты на классификацию + soft-lock override
- [ ] Wire в `vscode.scm.createSourceControl("vscodesync")` (deferred — UI wiring)
- [ ] Resource decoration на каждом file (icon + tooltip)

## 22.2 N02 — Notebook Cell-Level Conflict

- [x] Pure planner `planNotebookConflict(base, local, remote)`
- [x] Поддержка `nbformat 4` shape (cells[], source, metadata, outputs)
- [x] 6 actions: keep-base / keep-local / keep-remote / conflict / new-local / new-remote
- [x] `tryParseNotebook` — safe JSON parse
- [x] Outputs игнорируются при diff (executed state не считается intent)
- [x] Unit-тесты на каждый action
- [ ] Wire в conflict resolution QuickPick для `.ipynb` (deferred)

## 22.3 N03 — Workspace Import from .zip / .tar

- [x] Pure planner `planZipImport(entries, hint)`
- [x] Сanitisation: `../` rejected, leading `/` stripped, Windows-style `\` converted
- [x] OS noise filtering (`.DS_Store`, `Thumbs.db`)
- [x] vscodesync metadata skip (regenerated)
- [x] workspaceNote derivation из имени архива
- [x] Unit-тесты
- [ ] Команда `vscodesync.importWorkspaceFromArchive` + extraction wiring (deferred)

## 22.4 N04 — Activity Feed Webhook Digest

- [x] Pure formatter `formatDigestForWebhook(digest, format)`
- [x] 4 формата: Discord embeds / Slack blocks / Telegram MarkdownV2 / generic JSON
- [x] `detectWebhookFormat(url)` — host pattern detection
- [x] MarkdownV2 escape для Telegram
- [x] Unit-тесты на каждый формат
- [ ] Setting `vscodesync.digest.webhookUrl` + scheduled delivery (deferred — UI wiring)

## 22.5 N05 — Cross-Machine Sync Diff

- [x] Pure builder `buildCrossMachineDiff` — что изменилось на машине X с моего последнего sync
- [x] Excludes my own pushes
- [x] mySinceIso filter (по `vscodesync.json` `files[].lastSync`)
- [x] Group by machine + flat newest-first
- [x] Unit-тесты на фильтрацию + сортировку
- [ ] Команда `vscodesync.crossMachineDiff` + QuickPick UI (deferred)

## 22.6 N06 — Encrypted-at-Rest Local Backups

- [x] Pure wrapper `encodeBackupForWrite` / `decodeBackupAfterRead`
- [x] Использует существующий `encryptBuffer` / `decryptBuffer` (AES-256-GCM)
- [x] `.enc` suffix marker
- [x] Round-trip unit-тесты
- [ ] Setting `vscodesync.localBackup.encryptAtRest` (default `false`) (deferred)
- [ ] Wire в `backupLocalWithPrune` engine path (deferred)

## 22.7 N07 — "What's shared" SBOM Report

- [x] Pure builder `buildSbomReport` + `formatSbomMarkdown`
- [x] Aggregates total bytes, top heaviest files, per-workspace summary
- [x] Dedup machine ids per file
- [x] Unit-тесты на aggregation + sorting
- [x] Команда `vscodesync.exportSbom` в `package.json` (UI wire deferred)

## 22.8 N08 — `.syncexclude` UI-managed Store

- [x] Pure store `parseSyncExcludeFile` / `addExclusion` / `removeExclusion`
- [x] `isExcluded` с trailing-slash directory recursion
- [x] `emptySyncExcludeFile` с header comment
- [x] Idempotent add (no duplicates)
- [x] Unit-тесты на add/remove/check
- [ ] Right-click "Exclude from sync" → engine integration (deferred)

## 22.9 N09 — Trusted Teammates Registry

- [x] Pure registry `trustedMachinesRegistry`: `addTrusted` / `removeTrusted` / `isTrusted`
- [x] `parseTrustedRegistry` — sanitises malformed entries
- [x] `noteTrustedSeen` для housekeeping
- [x] Unit-тесты на 4 операции
- [ ] Integration: `requireMachineApproval` flow skips trusted ids (deferred — engine touch)
- [ ] Settings panel UI для add/remove (deferred)

## 22.10 N10 — Per-Glob Sync Schedule

- [x] Pure helpers `resolveWindowForPath` / `isWindowDue` / `groupFilesByWindow`
- [x] `matchesGlob` с поддержкой `*` (one segment) и `**` (any depth)
- [x] 5 windows: `immediate | hourly | nightly | weekly | never`
- [x] First-match-wins ordering
- [x] Unit-тесты на glob matching + due decisions
- [ ] Setting `vscodesync.perGlobSchedule` (deferred)
- [ ] Wire в `syncTriggerManager` (deferred — нужна fine-grained reroute)

## 22.11 N11 — Sync Progress Estimator (withProgress)

- [x] Pure class `SyncProgressEstimator` (window=20 samples, sliding)
- [x] `formatEta` — `<1s | 30s | 2m 30s | 1h 05m`
- [x] Stalled detection (>5s idle)
- [x] Unit-тесты на ETA decay + stall detection
- [ ] Wire в `pushAll` / `pullAll` через `vscode.window.withProgress` (deferred)

## 22.12 N12 — Mode-aware Welcome

- [x] Pure builder `buildWelcomeMessage(mode, pending, cloudNewer, conflict)`
- [x] Conflict-priority logic
- [x] 4 modes × 3 states = 12 messages
- [x] Russian plural agreement (1 / 2-4 / 5+)
- [x] CTA command + label per scenario
- [x] Unit-тесты на every branch
- [ ] Wire в Welcome view (`viewsWelcome` contribution) (deferred)

## 22.13 N13 — Tagged Release Notes Generator

- [x] Pure builder `buildReleaseNotes(from, to)` — added / modified / removed
- [x] `formatReleaseNotesMarkdown` — sections с alphabetical sort
- [x] netDelta calculation
- [x] Empty-state copy
- [x] Unit-тесты на classification
- [ ] Команда `vscodesync.generateReleaseNotes` для tagged snapshots (deferred)

## 22.14 N14 — Conflict Heatmap Timeline

- [x] Pure builder `buildConflictHeatmapTimeline(events, window)`
- [x] Day-bucketed aggregation
- [x] Peak day detection
- [x] Per-bucket top-N files
- [x] Window filter (fromIso / toIso)
- [x] Unit-тесты на bucketing + peak + edge cases
- [ ] Calendar-heatmap webview rendering (deferred — нужен HTML renderer)

## 22.15 N15 — VS Code Tasks Integration

- [x] Pure registry `TASK_REGISTRY` (push / pull / snapshot / prune-history / repair-manifest / support-bundle)
- [x] `VscodeSyncTaskDef` shape для `tasks.json` contributions
- [x] `lookupTaskMetadata(kind)` — pure lookup
- [x] Unit-тесты на uniqueness + valid commandIds
- [ ] Wire в существующий `vscodeSyncTaskProvider` (deferred — нужно extend `provideTasks`)
