# Changelog

All notable changes to **VSCodeSyncFiles** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows a custom `major.minor.maintenance` scheme (each part 0–99,
no carry on 9). See `CLAUDE.md` for build versioning rules.

## [Unreleased]

### Added
- Centralised logger (`src/utils/log.ts`) routes verbose / warn / error output
  to the existing `OutputChannel` instead of `console.*`.
- Shared loopback PKCE OAuth flow (`src/providers/_shared/pkceLoopbackOAuth.ts`)
  used by OneDrive / Google Drive / Dropbox / Yandex.Disk providers.
- `MAX_BYTES` body limit (64 KB) on Microsoft Graph webhook local server.
- `AbortSignal` and per-request timeout on OneDrive / Google Drive / Dropbox
  HTTP calls (matches existing Yandex behaviour).
- Status-bar conflict badge with error background colour when there are
  unresolved conflicts.
- Welcome view in the Workspaces tree when no workspaces are connected.
- `Ctrl+Alt+W` quick-switch QuickPick for active and suspended workspaces.
- Recently-changed smart group at the top of the Workspaces tree.
- `.editorconfig`, `SECURITY.md`, `CHANGELOG.md`, `husky` + `lint-staged`.

### Changed
- `vscodesync.conflictRules` setting now accepts `ConflictRule[]` objects
  matching the runtime schema (was misdeclared as `string[]`).
- `webhookTunnel` lifecycle: `dispose()` now reliably aborts the SSE stream
  and prevents reconnects (previously the disposed flag was never observed).
- `writeTextFileAtomic` Windows fallback writes to a sibling temp file before
  swapping, instead of overwriting in place.
- `normalizeLineEndings` collapses CRLF/CR in a single regex pass.

### Fixed
- `extension.web.ts` uses the correct extension id `borodatych.vscodesyncfiles`
  for `vscode.extensions.getExtension(...)`. The previous id never resolved.
- Dead branch `provider === "onedrive" === "onedrive"` in
  `oneDriveWebhookLifecycle` removed.
- Removed duplicate `vscodesync.migrateProvider` command (kept the working
  `vscodesync.migrateToAnotherProvider`).
- Verbose `console.*` output removed from soft-lock, sync trigger manager,
  Yandex provider and startup paths.

### Removed
- Unused `vscodesync.fileEncoding` setting (was never read by any code path).
- Stray `nul` file in the repository root (Windows accident).

## [0.4.0] — 2026-05-07

- Initial public history milestone (see Git log for the path here).
