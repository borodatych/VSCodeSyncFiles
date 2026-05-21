# Audit findings — 2026-05-21

> Сырой результат трёх параллельных аудитов (engine / UI / infra).
> Уже верифицировано против исходников; ложные срабатывания агентов
> отброшены и помечены ниже. Источник правды для Phase 24 roadmap.

## Engine / sync

| Where | Severity | Verdict |
|---|---|---|
| `syncEngine.ts:2885` soft-lock override | BUG (HIGH) | ✅ Уже исправлено в 24.A1 |
| `pullFile:3875-3882` ordering | BUG (HIGH) | ✅ Уже исправлено в 24.A2 |
| `checkOneFileStatus` missing `consensusLagsLocally` | BUG (HIGH) | ✅ Уже исправлено в 24.A3 |
| `deleteRemoteBlobBestEffort:3806-3814` swallows errors | SMELL | → 24.B1 |
| `snapshotHistoryNow:3836` `cur.notModified && body.length===0` | DEFENSIVE | Оставить, не проблема |
| `syncFileLock.ts:66-72` `run.then(noop,noop)` | OK (агент ошибся) | FIFO-цепь не пропускает rejection — by design |
| `metaMerge.pickNewer` tie-break silent | SMELL | → 24.B9 |
| `resolveFileConcurrency` default `1` | PERF | → можно поднять в `adaptiveConcurrency` |
| `hash.ts:94` тройная UTF-8 обработка | MICRO-PERF | Не критично |

## UI / UX

| Where | Severity | Verdict |
|---|---|---|
| `package.json` keybindings без `when` | UX | → 24.U1 |
| `package.json` commandPalette `when:false` × 18 | UX | → 24.U2 |
| `workspacesTree.refresh()` debounce vs `markPendingDelete` | BUG | → 24.B6 |
| `fileDecorations` async vs `refresh()` sync race | BUG | → 24.B7 |
| `statusBar.formatLastSync` AM/PM в ru locale | UX | → 24.B8 |
| `plannedPaletteCommands.ts:125` placeholder truncation | UX cosmetic | wontfix |
| Опасные операции без undo | UX | → 24.U3 |

## Infra / providers / security

| Where | Severity | Verdict |
|---|---|---|
| `gdriveProvider:158` `fetch` без timeout | BUG | → 24.B3 |
| `onedriveProvider:102` token refresh без timeout | BUG | → 24.B3 |
| `dropboxProvider:82,119` без timeout | BUG | → 24.B3 |
| `dropboxProvider:233` `void ifNoneMatch` | BUG (perf) | → 24.B4 |
| `globalConfigManager.set` без save | SMELL (хрупкий API) | → 24.B2 |
| Yandex использует `getMetadata` вместо HTTP 304 | INEFFICIENT | docs note, оставить |
| `wireCompression` нет миграционного пути для старых клиентов | SMELL | M3 BLAKE3 рядом, общий compat-сlayer |
| `encryption.ts` PBKDF2 200k + AES-256-GCM | OK | — |

## Ideas captured

- F1 Smart Pull Digest, F2 cursor-style presence, F3 diff-on-hover, F4 bulk pull selectively, F5 adaptive mode (quiet hours), F6 sync rewind, F7 Telegram digest, F8 "go home"-flow.
- M1 CDC chunking, M2 generic S3, M3 BLAKE3 write-path, M4 passkey-only, M5 GitHub Releases as provider.

## False positives

- "Двойные вложенные `return`" в `pullFile`/`pushFile` (`runWithSyncFileLock` → `withInFlightOp`) — by design,
  тесты покрывают, оставить.
- `cur.notModified && cur.body.length === 0` — это defensive guard для providers,
  у которых notModified=true может прийти с пустым телом без `ifNoneMatch`.
  Не баг, не убирать.
