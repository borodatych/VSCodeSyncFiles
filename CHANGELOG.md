# Changelog

All notable changes to **VSCodeSyncFiles** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows a custom `major.minor.maintenance` scheme (each part 0–99,
no carry on 9). See `CLAUDE.md` for build versioning rules.

## [Unreleased]

### Added
- **BLAKE3 migration check command** (v2.3.4) — `vscodesync.checkBlake3Migration` walks every active workspace's `_meta.json` and surfaces per-workspace BLAKE3 coverage + recommended action (`stay_sha256` / `stay_dual` / `recommend_switch` / `safe_to_switch_now`) via existing pure helpers. Dual-workflow start timestamp persisted in `globalState`. Backfill command (`completeBlake3Migration`) left as follow-up.
- **Smart Conflict Prediction — live presence reader** (v2.9.3) — `SmartConflictPredictionService` polls `_machines.json` every 60 s when an authenticated provider is available; peers' `currentEditing` frames cached for 60 s and augment the existing soft-lock score via `findHighRiskPeer`. Status-bar tooltip differentiates risk source (soft-lock / live presence / both).
- **P2P file-transfer engine hook** (v2.1.4) — `SyncEngineDeps.onPushFile?` callback fires after successful `pushMetaJson`. P2P UI runtime can mirror plaintext to peers via WebRTC DataChannel without re-canonicalising. Errors swallowed (best-effort).

### Changed
- **Smart features split** (v2.6.6 / v2.14.1) — extracted 5 engine-rich commands (`aiSessionSummary`, `aiSuggestWorkspaceTags`, `aiPathMapper`, `showInsightsWeeklyDigest`, `diffSnapshots`) from `plannedPaletteCommands.ts` into a focused `src/commands/registerSmartFeaturesEngine.ts` bundle with `{ context, globalConfig, tryAuthenticatedProvider }` contract.

### Added
- **Smart Conflict Prediction — currentEditing presence wire** (v2.9.2) — `presenceHeartbeat` теперь публикует поле `currentEditing` в `_machines.json` для self-entry: каждый tick резолвит `vscode.window.activeTextEditor` через `WorkspaceConfigManager` и пишет `{ workspaceId, relPath, sinceMs }` (или `null` при idle) с throttle 30 s через `shouldBroadcastCurrentEditing`. Mode (`full`/`anonymised`/`off`) читается из существующего setting `vscodesync.smartConflictPrediction.broadcastCurrentEditing`. `parseMachinesRegistry` / `upsertMachineAndPrune` / `syncMachinesRegistrySelf` расширены опциональным параметром (forward-compat).
- **AI privacy gate** (v2.14.2) — 3 новых setting'а `vscodesync.ai.{sessionSummary,suggestWorkspaceTags,pathMapper}.enabled` (default `false`). Команды `aiSessionSummary`, `aiSuggestWorkspaceTags`, `aiPathMapper` показывают opt-in toast с кнопкой `Open Settings` перед первой отправкой данных в LM. Описания указывают что покидает машину (paths only, never contents). `aiMerge` уже имел свой setting `vscodesync.aiMerge: boolean`.
- **AI cancellation** (v2.14.2) — все 3 AI-команды используют `withProgress({ cancellable: true })`; token прокинут в `summariseActivity` / `suggestWorkspaceTags` / `runAiPathMapper` для прерывания LM-запроса.
- **BLAKE3 dual-hash writer** (v2.3.2) — `pushFile` пишет `MetaEntry.hashBlake3` рядом с `hash` (sha256) когда setting `vscodesync.canonicalHashAlgo` = `"blake3"` или `"dual"`. Канонический pipeline (binary detect / BOM strip / line-ending normalise / strip syncignore) единый для обоих алгоритмов через extracted `canonicaliseToHashableBytes`.

### Changed
- **LoC guard tightened** (v2.6.7 / v2.11.4) — `tests/unit/extensionTsLoc.test.ts:LOC_CEILING` понижен с 850 до 820 после удаления tunnel imports.

### Internal
- **Tunnel-backend'ы cloudflared / tailscale-funnel удалены** — позиционирование «indie tool»; `smee.io` признан достаточным. Удалено 13 production-модулей + 9 unit-тестов (~2620 LoC). `oneDriveWebhookLifecycle.ts` откачен на прямой `createAndStartSmeeRelay`. Setting `vscodesync.webhooks.tunnelProvider` и команда `vscodesync.showTunnelStatus` убраны из `package.json`. v2.4 / v2.13 в roadmap помечены как DROPPED.

## [0.5.1] — 2026-05-08

Maintenance-релиз: wiring двух уже-готовых pure helper'ов в реальные UI-точки + накопленные за итерации `/roadmap-max` рефакторинги.

### Changed
- **Workspace lifecycle** — 4 команды (`suspendWorkspace` / `resumeWorkspace` / `freezeWorkspace` / `unfreezeWorkspace`) теперь используют единый `transitionWorkspaceSyncState` (state machine) через helper `validateWorkspaceTransition`. Inline-проверки `normalizeWorkspaceSyncState !== "X" || hasArchivedTag` заменены на централизованную валидацию. Отказы маппятся через `mapTransitionRejection(action, reason)` в ru-сообщения.
- **Onboarding wizard** — `vscodesync.startOnboarding` теперь использует `planOnboardingWizard` для skip-decisions: уже-настроенные шаги (провайдер / auth-токен / имя машины / подключённый workspace) пропускаются. При повторном запуске для уже-настроенного user'а показывается info-toast «VSCodeSync уже настроен» вместо прогона всех 4 шагов. В финальном toast'е перечисляются пропущенные шаги.
- **Snapshot retention manual flow** — pure planner `planSnapshotRetention` теперь подключён в manual `vscodesync.createSnapshot` (раньше работал только в scheduled пути). Workspace больше не накапливает снапшоты бесконечно через ручную команду.

### Fixed
- **Workspace state machine semantic** — `frozen.unfreeze` теперь резолвится напрямую в `active` (было `suspended`). Реальный flow `unfreeze` вызывает `repairLocalStateFromCloud` + `syncWorkspace`, оба заблокированы guard'ом `canSyncFromWorkspace` если destination = `suspended`. State machine была рассинхронизирована с UX.

### Internal
- 100+ коммитов после `v0.5.0`: `snoozeStore` консолидация в 3 UI-flow (machine approval, smart workspace suggestions, inactive archive); `findInactiveWorkspaceCandidates` дедуп между 2 UI-точками; webhook decoder + renew-tick wiring в OneDrive / Google Drive; `evaluateLongAbsence` + `planLocalBackupRetention` подключены в startup loop / pruneLocalBackups; cross-cutting pure helpers (P2P / passkey / tunnel / queue formatter / suspend state machine).
- Test count: **1604** unit-тестов (+77 новых test-файлов после `v0.5.0`).
- LoC дубликатов: -200+ через консолидацию через pure helpers.

## [0.5.0] — 2026-05-08

Большая функциональная волна за 9 проходов /roadmap-max: закрыты все
открытые пункты v1 roadmap, все 7 skeleton-фич Phase 12 «Quality pass»
доведены до полной реализации, разблокированы значимые куски v2
backlog (P2P crypto envelope, tunnel registry, конкретные фичи).

### Added — v2 progress
- WebRTC P2P crypto envelope: `src/core/p2pCryptoEnvelope.ts`
  (encodeP2PFrame / decodeP2PFrame, 8-байтовый clear header
  `[v=1][type:u8][seq:u32][reserved:u16=0]` + AES-256-GCM body, strict
  decoder с `{ ok, reason }`); `wrapAuthenticated` обёртка над
  `P2PChannel` с монотонным seq и replay-protection.
- Tunnel-провайдер registry: `tailscaleFunnelTunnelBackend` skeleton,
  оба backend'а (cloudflared + tailscale-funnel) зарегистрированы в
  `extension.ts:activate()`.
- CLI subpackage: `cli/vscodesync` для headless-sync без открытого VS Code
  (cmdAuth / cmdPull / cmdStatus, parseArgs, secret-store-env).

### Added — Phase 12 «Quality pass» полностью закрыта
- Bulk Push Wizard: команда `vscodesync.bulkPush` с QuickPick
  canPickMany + withProgress + OutputChannel `▶`/`✓`/`✗`;
  `engine.pushAll(workspaceId?, onProgress?): Promise<PushAllResult[]>`
  с двумя событиями на workspace.
- Hover Diff Preview: `HoverDiffPreviewProvider` со 5-сек TTL-кэшем,
  MarkdownString с trustedCommands `[Pull]` / `[Resolve Conflicts]`;
  setting `vscodesync.hoverDiffPreview.enabled`.
- Achievements: `runEvaluateAndPopup` (🏆 toast per новое достижение,
  persist в `globalState`), `runShowAchievements` OutputChannel;
  scheduleAchievementsWarmup (5-сек delay после activate). Команда
  `vscodesync.showAchievements`.
- Workspace Templates: `BUILT_IN_TEMPLATES` (Empty notes, Code
  snippets, Documentation) + `runInstallWorkspaceTemplate` (QuickPick
  → showOpenDialog → collision probe → modal → atomic-writes).
  Команда `vscodesync.installWorkspaceTemplate`.
- Snapshot Diff Viewer: `runSnapshotDiff` через встроенный
  `vscode.diff` editor (без webview). Команда `vscodesync.diffSnapshots`.
- Smart Conflict Prediction: `SmartConflictPredictionService` —
  status-bar warning при активном editor, чей файл уже помечен
  `editingBy` другой машиной через soft-lock pipeline. Setting
  `vscodesync.smartConflictPrediction.enabled`.
- Time Travel scrubber: webview с `<input type="range">` + `<pre>`
  viewer над `.history/{relPath}/`, monotonic sequence guard от race на
  медленный download. Команда `vscodesync.openTimeTravelScrubber`.

### Added — wiring + tooling
- Insights weekly digest: `buildWeeklyDigest` (агрегаты по
  kind/file/machine/workspace/day, busiest/quietest) + команда
  `vscodesync.showInsightsWeeklyDigest`.
- Stats Dashboard sankey "push → pull" (vanilla SVG, без D3) — команда
  `vscodesync.openSankeyChart`.
- Conflict heatmap CodeLens "flame" — `ConflictHotZoneCodeLensProvider`
  + real line ranges из inline-CodeLens
  (`vscodesync.{keepMine,takeTheirs}WithRange`).
- AI Path Mapper auto-prompt после `attachCloudWorkspace` (idempotent
  через globalState).
- Husky + lint-staged (`.husky/pre-commit`, `.lintstagedrc.json`).
- Centralised logger (`src/utils/log.ts`) routes verbose / warn / error
  output to the existing `OutputChannel` instead of `console.*`.
- Shared loopback PKCE OAuth flow (`src/providers/_shared/pkceLoopbackOAuth.ts`)
  используется OneDrive / Google Drive / Dropbox / Yandex.Disk.
- Welcome view в Workspaces tree, `Ctrl+Alt+W` quick-switch,
  Recently-changed smart group.
- `.editorconfig`, `SECURITY.md`, `CHANGELOG.md`, `.github/workflows/release.yml`.

### Changed
- `vscodesync.conflictRules` setting accepts `ConflictRule[]` objects
  matching the runtime schema (was misdeclared as `string[]`).
- `webhookTunnel.dispose()` reliably aborts the SSE stream and prevents
  reconnects (previously the disposed flag was never observed).
- `writeTextFileAtomic` Windows fallback writes to a sibling temp file
  before swapping.
- `normalizeLineEndings` collapses CRLF/CR in a single regex pass.

### Fixed
- `extension.web.ts` uses the correct extension id
  `borodatych.vscodesyncfiles` (previous id never resolved).
- `engineCallbacks > onNewConflict 3-way` test stabilised — clear etag
  when patching meta (ETag-cache short-circuit was masking the conflict).
- `syncRateLimitState` fallback off-by-1 (1-ms cushion in
  `noteProviderRateLimited`).
- Dead branch `provider === "onedrive" === "onedrive"` in
  `oneDriveWebhookLifecycle` removed.
- Duplicate `vscodesync.migrateProvider` command removed (kept the
  working `vscodesync.migrateToAnotherProvider`).
- Verbose `console.*` output removed from soft-lock, sync trigger
  manager, Yandex provider and startup paths.

### Removed
- Unused `vscodesync.fileEncoding` setting.
- All `*NotImplementedError` sentinels for fully-shipped Phase 12 features
  (Bulk Push, Hover Diff, Achievements, Workspace Templates, Snapshot Diff,
  Smart Conflict Prediction, Time Travel).

### Tests
- 716 / 0 passes (was 262 in 0.4.0). New direct coverage:
  `tests/unit/encryption.test.ts` (13), `tests/unit/syncAutoPause.test.ts`
  (9), плюс ~50 unit-тестов на новые pure helpers.

## [0.4.0] — 2026-05-07

- Initial public history milestone (see Git log for the path here).
