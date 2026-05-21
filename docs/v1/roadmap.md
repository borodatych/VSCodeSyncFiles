# VSCodeSync v1 — Главный роадмап

> Точка входа. Каждая фаза — самодостаточный модуль, но порядок фаз важен: каждая следующая строится на предыдущей.

## Фазы

| # | Фаза | Описание | Статус |
|---|------|----------|--------|
| 1 | [Foundation](01-foundation/roadmap.md) | Скаффолдинг, конфиги, абстракция провайдера | `[x]` |
| 2 | [Core Sync](02-core-sync/roadmap.md) | OneDrive + workspace + push/pull + конфликты | `[x]` |
| 3 | [UI](03-ui/roadmap.md) | Статус-бар, боковая панель, контекстное меню, онбординг | `[x]` |
| 4 | [Reliability](04-reliability/roadmap.md) | Триггеры, оффлайн-очередь, ETag, rate limits, file lock | `[x]` |
| 5 | [Providers](05-providers/roadmap.md) | Google Drive, Яндекс Диск, Dropbox, переключение | `[x]` |
| 6 | [Power Features](06-power-features/roadmap.md) | Quick Transfer, Watch Mode, Git, Snapshots, Ignore, Шифрование (+ 6.1–6.7 в roadmap) | `[x]` |
| 7 | [UX Polish](07-ux-polish/roadmap.md) | Activity feed, телеметрия, структура | `[x]` |
| 8 | [Platform](08-platform/roadmap.md) | Tasks, CI, compression, Multi-root, CLI… | `[x]` |
| 9 | [Hardening](09-hardening/roadmap.md) | Баг-фиксы из аудита, дедуп PKCE, lint=0, dx-инфра (CHANGELOG/SECURITY/.editorconfig) | `[x]` |
| 10 | [Quick Wins](10-quick-wins/roadmap.md) | Welcome view, Ctrl+Alt+W quick switch, Recently changed sort | `[x]` |
| 11 | [Feature Pack](11-feature-pack/roadmap.md) | Scheduled snapshots, Walkthroughs, AI summary, i18n, presence heartbeat… | `[x]` |
| 12 | [Quality pass](12-quality-pass/roadmap.md) | webviewNonce dedupe, @experimental маркеры, mass-delete guard, queue dedupe, sparkline, online indicator, AI commit message | `[x]` |
| 13 | [Integrations](13-integrations/roadmap.md) | Wiring F1-F5, race-guards, formatNotification, F-3.1..F-3.8 (export, restore, AI path mapper, replay, heatmap, garbage detector, storage report) | `[x]` |
| — | **v0.7 — Performance & autoSyncMode** (без отдельного phase doc, перфоманс-пакет 2026-05-21) | parallelLimit, gdrive folder cache, lazy history, sync profiler, **autoSyncMode** default `check-only`, batched cfg writes, settings panel «Производительность» | `[x]` |
| 14 | [Safety & Recovery](14-safety-recovery/roadmap.md) (v0.8) | Auto-snapshot перед destructive ops, quota exhaustion, repair manifest, re-queue after auth expiry, listFolder pagination, keep-both для конфликтов | `[ ]` |
| 15 | [Observability & Debug](15-observability/roadmap.md) (v0.9) | Единый OutputChannel + log level, support bundle export, `explainFileSyncState`, централизованный retry, status webview tab | `[ ]` |
| 16 | [UX & Modern](16-ux-modern/roadmap.md) (v0.10) | First-run banner для check-only, DnD из Explorer, `vscodesync://` URI scheme, animated decorators, AI Explain Conflict, контекстуальные хинты | `[ ]` |
| 17 | [Finish underbaked](17-finish-underbaked/roadmap.md) (v0.11) | WebRTC P2P signaling round-trip, Passkey recovery codes UI, WASM zstd+BLAKE3 на write-path, AI Bulk Review on push, Sync Replay jump-to-as-of | `[ ]` |
| 18 | [Provider parity](18-provider-parity/roadmap.md) (v0.12) | Dropbox upload session, OneDrive per-chunk retry, resumable downloads, унифицированный post-upload integrity check | `[ ]` |
| 19 | [DX & Quality](19-dx-quality/roadmap.md) (v0.13) | Unit tests на SyncEngine, HTML snapshot tests, contract tests на ICloudProvider, fixture-driven replay, .gitignore watcher, worktree/devcontainer awareness | `[ ]` |
| 20 | [Modern bonus](20-modern-bonus/roadmap.md) (v0.14) | Settings Sync wiring, workspace template marketplace UI, multi-account display, light/dark icon variants, quick switch с sparkline | `[ ]` |
| 21 | [User-visible wiring](21-wiring/roadmap.md) (v0.15) | W01–W14: repair-manifest command, explain-file-state, keep-both context menu, contextual hints scheduler, vscodesync:// URI handler, .gitignore watcher, AI explain conflict, support bundle | `[~]` |
| 22 | [Modern features](22-modern-features/roadmap.md) (v0.16) | N01–N15: SCM-style integration, notebook conflict planner, zip import, webhook digest formatter, cross-machine diff, encrypted-at-rest backups, SBOM report, .syncexclude store, trusted teammates, per-glob schedule, progress estimator, welcome formatter, release notes, conflict timeline, task definitions | `[~]` |
| 23 | [Finish & polish](23-finish-and-polish/roadmap.md) (v0.17 → v0.18) | A1–A13 bug fixes, D01–D06 wiring (provider hash verify, quota banner, withRetry, exportSbom, vscode tasks, trusted teammates), N16–N21 helpers + W1–W6 wiring (invite link commands, connectivity probe widget, schema migrator hook, adaptive concurrency in engine, .vscodesyncrc.json watcher, registry memoisation). Финальная фаза текущей серии v1. | `[x]` |

**Стратегические направления v2:** см. [`docs/v2/roadmap.md`](../v2/roadmap.md)
(WebRTC P2P sync, Passkey unlock, WASM zstd+BLAKE3, cross-cloud backup mirror, декомпозиция `extension.ts`). Конкретные шаги завершения — в Phase 17 выше.

---

## Ключевые архитектурные решения (зафиксировано)

- **Один активный провайдер** глобально (v1). Несколько одновременных — v2+.
- **`.vscode/vscodesync.json`** — машино-специфичный кэш, не источник истины. Источник истины — `.vscodesync-workspace.json` на облаке.
- **Manifest-first**: манифест workspace'а синхронизируется раньше файлов.
- **Lamport timestamps** (`version`) в манифесте для разрешения гонок при merge.
- **ETag + `If-Match`** для атомарных PUT файлов и `_meta.json`.
- **Canonical pipeline**: `normalize_line_endings → sanitize_syncignore → SHA-256 → [compress] → [encrypt] → upload`
- **Хэш** всегда от нормализованной санированной версии (одинаков на Windows/Linux).
- **Теги** как отдельное поле `tags[]` в манифесте (не парсинг из названия).
- **gitBranch** хранится в облачном манифесте (одинаково на всех машинах).
- **Multi-root workspace**: каждая папка независима, свой `vscodesync.json`.

---

## Структура облачного хранилища (справка)

```
VSCodeSyncFiles/
  {workspaceId}/
    .vscodesync-workspace.json   ← манифест (состав файлов, теги, ветка, машины)
    _meta.json                   ← последнее синхронизированное состояние файлов (hash, version)
    .history/{path}/             ← история версий (до 10 версий, настраивается)
    .snapshots/{name}/           ← снапшоты workspace'а
    {файлы...}
  _quicktransfer/{uuid}/         ← разовые передачи
  _machines.json                 ← реестр всех машин
```

---

## Структура локальных конфигов (справка)

```
~/.vscode/vscodeSync/
  config.json          ← activeProvider, machineId, machineName, токены
  stats.json           ← статистика (локально)
  activity.json        ← лог событий (локально, 90 дней)
  queue.json           ← оффлайн-очередь автосинка (fullSync / push / pull)
  schedule-deferred.json ← отложенные операции вне окна расписания
  {hash}.lock          ← lock-файл для параллельных окон VSCode

{project}/.vscode/
  vscodesync.json      ← activeWorkspaces, files (кэш, не источник истины)

{project}/
  .vscodesync-ignore   ← паттерны исключений (gitignore-синтаксис)
```
