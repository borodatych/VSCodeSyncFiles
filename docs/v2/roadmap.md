# VSCodeSync v2 — стратегические направления

> Большие куски, которые меняют архитектурные основания v1. Каждый — `XL` или `L`,
> требует отдельной планёрки и тестового матрикса. Здесь — спецификация уровня роадмапа,
> детальный план поднимать перед реализацией каждого.

## 1. WebRTC P2P sync (cloud-bypass mode) — XL · skeleton

**Прогресс ночной волны:**
- Signaling envelope: `src/core/p2pSignaling.ts` со strict-decoder (offer/answer/ice/bye, freshness-window, recipient-binding). 13 unit-тестов.
- DataChannel layer: `src/core/p2pDataChannel.ts` поверх `@roamhq/wrtc` (lazy-load, fallback к null если binding не установлен). 8 unit-тестов на fake channel: send/onMessage round-trip с ArrayBuffer / Uint8Array / TypedArrayView, isOpen state, idempotent close.
- **Crypto envelope подключён:** `src/core/p2pCryptoEnvelope.ts` (`encodeP2PFrame / decodeP2PFrame` поверх существующих `encryptBuffer/decryptBuffer`). Wire-format: `[v=1][type:u8][seq:u32][reserved:u16=0][AES-256-GCM body]`. Strict-decoder возвращает `{ ok:false, reason }` на короткий header / unknown version / unknown type / non-zero reserved / authTag failure / seq mismatch. 12 unit-тестов.
- **DataChannel intеграция:** `wrapAuthenticated(P2PChannel, key)` в `p2pDataChannel.ts` оборачивает raw channel в `AuthenticatedP2PChannel` с `sendFrame(type, payload)` / `onFrame(handler, onReject)`. Сам ведёт outSeq и expectedInSeq (оба u32 c wrap-around). Replays / out-of-order / authTag-failures маршрутизируются в `onReject`, валидные — в `onFrame`. 6 дополнительных unit-тестов в `tests/unit/p2pDataChannel.test.ts`.
- **Что осталось:** команда «start P2P session» в UI + signaling round-trip через webhook-канал (smee.io / cloudflare-tunnel) или QR-обмен offer/answer.

**Зачем:** облако вносит лаг 5–30 с и тратит API-квоту, когда обе машины онлайн (типичный
workflow «дом → стенд RDP»). Дифференциатор: «единственное расширение, которое умеет cloud + P2P».

**Что:**
- Signaling — через существующий webhook-канал (smee.io / Cloudflare-tunnel) ИЛИ через QR-обмен offer/answer для air-gapped пар.
- Transport — DTLS поверх WebRTC DataChannel; payload-обёртка через текущий `ICrypto` (AES-256-GCM).
- Manifest-first сохраняется: P2P доставляет файлы, манифест по-прежнему через провайдера.
- Облако — fallback / cold storage. P2P активна пока обе машины в `_machines.json` отмечены онлайн (heartbeat).

**Ограничения:** не свой signaling-сервер (нарушает позиционирование «нет наших серверов»).

## 2. Passkey/WebAuthn-разлок ключа шифрования — M · skeleton

**Прогресс ночной волны:** envelope-shape готов — `src/core/keyEnvelope.ts` (`KeyEnvelope` v1: `none` / `passphrase` / `webauthn`, `isKeyEnvelope` валидация, `envelopeNoneFromRawKey`/`rawKeyFromNoneEnvelope` round-trip, `bytesToB64`/`b64ToBytes`, `constantTimeEqual`). 13 unit-тестов. `deriveWebauthnKek` бросает `KeyEnvelopeNotImplementedError` — UI должен ловить и предлагать enroll.

**Зачем:** ключ AES-256 живёт в SecretStorage как чистый секрет — компрометация ОС =
компрометация всех воркспейсов. Восстановления у пользователя нет.

**Что:**
- Дополнительный слой KEK через `navigator.credentials` (web) / native FIDO2 (desktop).
- KEK оборачивает существующий DEK; blob-ы в облаке не меняются (обратная совместимость).
- Повторный анлок — биометрия / hardware key.
- Опциональный fallback на passphrase, опциональное второе устройство.

## 3. WASM-ядро: zstd + BLAKE3 — L · partially DONE

**Прогресс ночной волны:**
- Wire-format готов — `src/core/wireCodec.ts` с pure-helpers `detectWireCodec / chooseWireCodec / flagsForCodec / describeCodec`. `MetaEntry.wireZstd?: boolean` объявлен в `cloudLayout.ts` (mutually exclusive с `wireGzip`). 11 unit-тестов на codec selection.
- **Backend подключён:** `@bokuweb/zstd-wasm` как optional-dep, `zstdAddon()` в `platformCompression.ts` с lazy init. `ICompression` расширен `zstd / unzstd / zstdAvailable` (опциональные, fallback к gzip когда binding недоступен). 2 smoke-теста (compression round-trip + skip-when-incompressible).
- **BLAKE3 backend подключён:** `@noble/hashes/blake3` как optional-dep (~30 KB minified, pure JS — no native deps). `src/core/hashProviders.ts` с интерфейсом `HashProvider` + `selectHashProvider("sha256" | "blake3")` + `hashesEqual` constant-time. 10 unit-тестов с известными test vectors. Полная замена SHA-256 → BLAKE3 в pipeline `computeHash` — следующая итерация (нужен `vscodesync.canonicalHashAlgo` setting и migration plan, иначе старые манифесты не сматчатся).

**Зачем:** Rabin-Karp на JS и gzip на `node:zlib` упираются в CPU при больших файлах; web-вариант не имеет node:zlib.

**Что:**
- WASM-модуль с `zstd` (compression level 3 для текста) и `BLAKE3` (хэш).
- `wireZstd` рядом с `wireGzip` в `_meta.json` (новое поле, опт-ин).
- Десктоп: 5–15× ускорение delta-sync; web: единый рантайм.
- `ICompression` уже абстрактен — реализация добавится через ту же абстракцию.

## 4. Cloudflare / Tailscale tunnel-провайдер — M · skeleton

**Прогресс ночной волны:** tunnel-dispatcher contract готов — `src/ui/tunnelProviderRegistry.ts` (`TunnelBackend` interface + `openTunnel` / `registerTunnelBackend` / `resolveTunnelType`), 5 unit-тестов. Backend `cloudflaredTunnelBackend` есть в skeleton-режиме (probes `cloudflared --version` на PATH; не spawn-ит долгоживущий процесс). Setting `vscodesync.webhooks.tunnelProvider` (smee | cloudflared | tailscale-funnel) объявлен. Полная реализация spawn + URL-scrape — отдельная итерация.

**Symmetric Tailscale skeleton:** `src/ui/tunnelBackendTailscale.ts` (`tailscaleFunnelTunnelBackend`) — параллельный backend с `tailscale --version` probe, fail-soft с подсказкой про Funnel ACL. 4 unit-теста на shape + config_invalid пути (probe не запускается, чтобы тест не блокировался на spawn timeout).

**Backends зарегистрированы:** оба backend'а регистрируются в registry в `extension.ts:activate()` (sync, top-level imports). Теперь `openTunnel("cloudflared", port)` / `openTunnel("tailscale-funnel", port)` возвращают полезный `not_available` detail (probe + TODO) вместо «backend not registered». Миграция `webhookTunnel.ts` на `openTunnel(resolveTunnelType(setting), port)` с smee fallback — отдельная итерация.

**Зачем:** smee.io — публичный relay без SLA; для серьёзных пользователей deal-breaker.

**Что:**
- Setting `vscodesync.webhooks.tunnelProvider`: `smee` (default) | `cloudflared` | `tailscale-funnel`.
- Cloudflare Quick Tunnel — pinned subdomain, TLS, один бинарник; запуск через `child_process.spawn`.
- Tailscale Funnel — для пользователей в tailnet. Нужен `tailscale` CLI на машине.

## 5. Cross-cloud backup mirror — DONE (ночная волна, минимально + snapshots)

- `src/ui/crossCloudBackup.ts` — фоновый job, polling 30 мин, читает `vscodesync.backup.secondaryProvider` и `backup.intervalDays`. На каждом due-моменте: для каждого active workspace зеркалит manifest + `_meta.json` + `.snapshots/` (recursive listFolder с heuristic `size === undefined → folder`).
- `.history/` recursive copy — намеренно skipped: per-file deep, дорого по quota; manifest + snapshots достаточно для recovery.
- Off by default; secondary должен быть авторизован и отличаться от primary.

**Зачем:** один провайдер = одна точка отказа (заблокированный аккаунт = всё пропало).

**Что:**
- Setting «secondary provider for backup»: раз в неделю manifest + `_meta.json` + `.history/` копируются в другое облако.
- Автоматическое восстановление при недоступности primary провайдера → опция switch на mirror.
- UI: «Backup: last sync X ago, target: Google Drive».

## 6. Декомпозиция `extension.ts` — L · in progress

**Прогресс ночной волны:**
- `src/commands/registerPanels.ts` — webview-opener команды (machines graph, quick-transfer drop).
- `src/commands/registerActivitySearches.ts` — 4 команды saved-search/alerting (-150 LoC из `extension.ts`, удалены unused imports).
- Контракт фиксирован: `PanelCommandsDeps` / `ActivitySearchCommandsDeps` принимают только `context` и нужные store-paths; ни один `runWithEngine` / global state не утекает в эти модули.
- Остальные 60+ команд (workspace lifecycle, file ops, conflicts, providers) — следующая итерация: каждая группа = свой файл с тем же контрактом, без рефакторинга `activate(...)`.

**Зачем:** 4533 LoC в одном файле, 60+ команд. Каждое изменение — мерж-конфликт-машина.

**Что:**
- `src/commands/` директория с одним файлом на тематическую группу (`workspace.ts`, `file.ts`, `provider.ts`, `tree.ts`, `health.ts`, ...).
- Каждый файл экспортирует `register…(context, deps)`.
- `extension.ts` остаётся `< 500 LoC` и состоит только из wiring.
- Ничего не меняется в поведении команд — рефактор без feature impact.

## 7. Open VSX автопубликация — DONE (ночная волна)

- `.github/workflows/release.yml` создан: на push tag `v*` собирает VSIX, публикует параллельно в VS Code Marketplace (`@vscode/vsce publish`) и Open VSX (`ovsx publish`), создаёт GitHub Release с auto-generated notes. CI matrix (Linux/Windows/Mac) — на каждый push.
- Secrets для активации: `VSCE_PAT` (Marketplace) и `OVSX_PAT` (Open VSX). Без них шаги пропускаются — релиз всё равно проходит до GitHub Release.

## 8. Cursor / Windsurf compatibility test matrix — DONE (ночная волна, частично)

- Job `cursor-smoke` в `release.yml`: проверяет, что `engines.vscode` ≤ `^1.92` (Cursor / Windsurf отстают от upstream VS Code на 1-2 минора). `continue-on-error: true` — не блокирует merge.
- Полный smoke-test на реальных IDE требует self-hosted runner с установленным Cursor — отложено.
- Проверка `vscode.lm`, `SecretStorage`, OAuth UriHandler в реальном Cursor — ручной QA перед каждым публичным релизом.

---

## Anti-recommendations (что НЕ делать)

- **CRDT/Yjs/Automerge для манифеста** — `Lamport + ETag + If-Match` уже решает race-conditions на манифестах ~1 KB; CRDT добавит ~150 KB рантайм-зависимости и удвоит схему без видимого выигрыша.
- **LSP-интеграция** — VSCodeSync синхронизирует файлы, не семантику; LSP здесь — over-engineering без сценария.
- **Свой signaling/relay-сервер для P2P** — нарушает позиционирование «нет наших серверов»; signaling должен идти через webhook-канал существующего провайдера или через QR-обмен offer/answer.
- **Полный CRDT real-time editing (a-la Live Share)** — это другой продукт; Live Share уже делает. VSCodeSync — про устойчивые файловые состояния.
- **Поддержка third-party serverless KV (Vercel/Supabase) для метаданных** — ломает обещание «только ваше облако».
- **Дополнительные облачные провайдеры (S3, MEGA, Box) сейчас** — пятеро уже есть; шестой принесёт <5% аудитории, но удвоит test-matrix.
- **Mobile companion (iOS/Android sync viewer)** — out-of-scope для VSCode-расширения; сила VSCodeSync именно в IDE-первости.
- **Дополнительные эмодзи в notifications** — текущий перебор уже мешает корп-юзерам; чистить, а не добавлять (см. Phase 11 → Emoji-free режим).
