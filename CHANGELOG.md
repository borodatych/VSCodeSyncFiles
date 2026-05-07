# Changelog

All notable changes to **VSCodeSyncFiles** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows a custom `major.minor.maintenance` scheme (each part 0–99,
no carry on 9). See `CLAUDE.md` for build versioning rules.

## [Unreleased]

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
