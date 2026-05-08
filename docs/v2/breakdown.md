# VSCodeSync v2 — Breakdown (детальные подэтапы)

> Разбивка [v2/roadmap.md](roadmap.md) на конкретные подэтапы с чекбоксами.
> Каждый пункт здесь — должен быть закрываемым отдельно (одним фокусированным
> прогоном), чтобы `/roadmap-max` мог их инкрементально подхватывать.
>
> **Принцип:** нижестоящий пункт зависит от верхнестоящего. Не браться за `v2.X.4`,
> пока `v2.X.1..3` не закрыты — иначе нечего тестировать.

---

## v2.1. WebRTC P2P sync — UI + signaling

**Текущее состояние:** signaling envelope, DataChannel, crypto envelope,
wrapAuthenticated — все готовы и тестированы. UI и signaling round-trip — нет.

### v2.1.1. Signaling channel поверх manifest cloud

- [x] **`src/core/p2pSignalingChannel.ts`** — pure helpers `cloudPathForSignaling`, `cloudPathForIceCandidate`, `cloudPathForSessionFolder`, `buildSignalingEnvelope`, `decodeSignalingEnvelope`. TTL 60 s, oversized + bad_json + kind/session-mismatch + stale rejection. 11 unit-тестов в `tests/unit/p2pSignalingChannel.test.ts`.
- [x] **`src/ui/p2pSignalingTransport.ts`** — `createSignalingTransport({ provider, workspaceWritable, now })` с `writeOffer/Answer/Bye`, `writeIceCandidate`, `pollForOffer/Answer` (exponential backoff с timeout), `listIceFromPeer`, `cleanupSession` (после 5 мин idle). 11 unit-тестов в `tests/unit/p2pSignalingTransport.test.ts` через fake provider с in-memory blob store.
- [x] Permission-check: `workspaceWritable: false` → `SignalingNotWritableError` на любой write. Read-only поток (poll/listIce) работает без write permissions.

### v2.1.2. Альтернативный air-gapped signaling через QR-обмен

- [ ] **`src/ui/p2pQrExchange.ts`** — генерация QR-кода offer / answer, парсинг сканированного. Используем существующий QR-код код (если есть) или JS-библиотеку `qrcode-terminal` для ASCII.
- [ ] UI flow: «inviter генерирует offer → показывает QR → invitee сканирует → invitee показывает answer → inviter сканирует».
- [ ] Maximum payload: 2 KB (limit QR версии 30L). Если offer больше — split на N QR-кодов с sequence number.

### v2.1.3. UI команда «Start P2P session»

- [ ] **`vscodesync.startP2PSession`** — multi-step QuickPick:
  - Шаг 1: «Я приглашаю / Я присоединяюсь».
  - Шаг 2 (inviter): pick target machine (из `_machines.json` online). Generate offer → write через signaling channel → poll answer.
  - Шаг 2 (invitee): list active sessions on cloud → pick → read offer → generate answer → write.
  - Шаг 3: ICE exchange → connection established.
- [ ] Status-bar widget: «$(broadcast) P2P: 1 peer (alpha)». Click → quick disconnect.
- [ ] Auto-disconnect на 5 минут idle.

### v2.1.4. Файловая передача через P2P

- [x] **`src/core/p2pFileTransfer.ts`** — pure planner `planP2PFileChunks` (16 KB default, last chunk = remainder, empty file = 1 zero-length chunk), `encodeManifestPayload`/`decodeManifestPayload` (strict shape + 16 KB cap), `encodeFileChunkPayload`/`decodeFileChunkPayload` (8-byte BE header: u32 chunkIndex + u32 length). 19 unit-тестов.
- [x] Receiver: `createChunkAssembler(manifest)` — out-of-order delivery, idempotent на duplicates, finalize() возвращает `{ content, hashOk }` (recompute SHA-256 + compare с manifest). Пишет в файл — обвязка наверху (UI layer).
- [~] Hook в `syncEngine.pushFile` — pure planner готов, обвязка к live engine ждёт `vscodesync.startP2PSession` UI команды (v2.1.3, остаётся skeleton).

### v2.1.5. Lifecycle и health

- [ ] Heartbeat каждые 30 с (через тот же DataChannel: `wrapAuthenticated.sendFrame("ping", ...)`).
- [ ] Reconnect-on-failure: discriminated-union state machine (`Connecting | Connected | Reconnecting | Disconnected`), retry с exponential backoff.
- [ ] Activity log: `kind: "p2p_started" | "p2p_chunk_sent" | "p2p_ended"`.

### v2.1.6. Smoke-test environment

- [ ] **`docs/v2/p2p-smoke-guide.md`** — шаги воспроизведения: 2 VS Code window (или 1 + extension host dev), один workspace, инициировать session, послать тестовый файл, проверить что он пришёл с правильным hash.
- [ ] CI smoke: invoke session in single-process mode (loopback peer connection через `@roamhq/wrtc`).

---

## v2.2. Passkey / WebAuthn — разлок ключа шифрования

**Текущее состояние:** envelope-shape готов в `keyEnvelope.ts`. `deriveWebauthnKek`
бросает sentinel.

### v2.2.1. Web platform (browser, vscode.dev)

- [ ] **`deriveWebauthnKek` real impl (web)** — `navigator.credentials.create({ publicKey: { ... } })` для enrollment, `.get(...)` для unlock. Берём credential id, hash через PBKDF2 или HKDF.
- [ ] **Storage:** credential id хранится в `globalState['vscodesync.webauthn.credentialId']`. KEK (derived) — никогда не персистится; при каждом unlock запрашивается биометрия.

### v2.2.2. Desktop platform (electron / vscode native)

- [ ] **Native FIDO2:** через webview API → `navigator.credentials` (vscode webviews используют Chromium inside, поддерживают WebAuthn).
- [ ] Альтернатива: native binding `node-webauthn` (но native dep). Skeleton-acceptable если binding не установлен.

### v2.2.3. UI flow

- [ ] **Команда `vscodesync.enrollPasskey`** — модалка «Add hardware key / biometric»: generate credential → store id → wrap existing DEK с derived KEK → write encrypted envelope в SecretStorage.
- [ ] **Команда `vscodesync.unlockWithPasskey`** — при попытке использовать DEK после lock: prompt biometric → derive KEK → unwrap DEK.
- [ ] **Команда `vscodesync.removePasskey`** — удалить credential id (DEK остаётся wrapped, нужен fallback passphrase).

### v2.2.4. Recovery + fallback

- [ ] **5 одноразовых recovery codes** — генерируются при enrollment, показываются один раз, hash сохраняется в SecretStorage. Каждый code — alternate KEK.
- [ ] **Passphrase fallback** — пользователь вводит passphrase (PBKDF2 → KEK). Активируется если credential lost.
- [ ] **Multi-device** — несколько credential id на разных машинах + recovery codes для cross-device recovery.

### v2.2.5. Settings UI

- [ ] **`vscodesync.showPasskeySettings`** — webview со списком enrolled devices (date, device name from user-agent), действия: rename, remove, regenerate recovery codes.

### v2.2.6. Tests + telemetry

- [ ] Unit-тесты на envelope wrap/unwrap (без реального WebAuthn — используем mock derive function).
- [ ] Telemetry: track WebAuthn failure reasons (NotAllowedError, NotSupportedError, AbortError) для понимания edge cases у пользователей.

---

## v2.3. BLAKE3 migration с dual-hash transition

**Текущее состояние:** BLAKE3 backend подключён, `selectHashProvider` готов.
Switch SHA-256 → BLAKE3 в `computeHash` сломает совместимость со старыми манифестами.

### v2.3.1. Setting + hash field

- [ ] **Setting** `vscodesync.canonicalHashAlgo`: `"sha256"` (default) | `"blake3"` | `"dual"`. `dual` — пишет оба хеша, читает оба.
- [ ] **Расширить `MetaEntry`:** добавить optional `hashBlake3?: string` рядом с `hash` (которое sha256). Forward-compat: старые readers игнорируют unknown field.

### v2.3.2. Dual-hash writer

- [ ] **`computeHashDual`** — pure helper в `hash.ts`: возвращает `{ sha256: string; blake3: string }`. Используется когда setting === `"dual"` или `"blake3"`.
- [ ] **`pushFile` writes both** — при upload пишет оба хеша в meta, чтобы любой reader (старый sha256-only или новый blake3) мог совпасть.

### v2.3.3. Reader compatibility

- [ ] **`hashesEqual` extended** — pure helper: если manifest имеет `hashBlake3` и мой alg `blake3` → сравнить blake3. Иначе — sha256 (всегда есть).
- [ ] **Migration check at startup** — `runHashAlgoMigrationCheck`: read all `_meta.json`, count entries with/without `hashBlake3`. Если все имеют → safe to switch to `blake3`-only. Показывает в `vscodesync.showHashMigrationStatus`.

### v2.3.4. Transition window

- [ ] Default workflow: пользователь ставит setting `dual` → next sync пишет оба хеша → через 7 дней (или command «complete migration») setting → `blake3` → старые sha256-only meta entries lazily upgrade на следующий push.
- [ ] **Команда `vscodesync.completeBlake3Migration`** — фоновая задача: для каждого workspace, для каждого файла без `hashBlake3` → recompute и write meta (без download blob — берём local hash, поскольку local hash должен совпадать).

### v2.3.5. Performance + telemetry

- [ ] Бенчмарк-тесты: типичный workspace (100 файлов × 50 KB) — sha256 vs blake3 wall-time. Опубликовать в `docs/v2/blake3-benchmark.md`.
- [ ] Activity log: `kind: "hash_migration"` при upgrade meta entry.

---

## v2.4. Cloudflare / Tailscale tunnel — full spawn + webhookTunnel migration

**Текущее состояние:** оба backend'а — skeleton'ы (probe binary, return `not_available`).
Зарегистрированы в registry. `webhookTunnel.ts` всё ещё вызывает `createAndStartSmeeRelay` напрямую.

### v2.4.1. Local HTTP server абстракция

- [ ] **`src/ui/webhookLocalServer.ts`** — выделить из `graphWebhookLocalServer.ts` provider-agnostic shape: `startLocalWebhookServer(port?: number, handler: (payload, headers) => void): Promise<{ port: number; dispose(): Promise<void> }>`.
- [ ] Тесты: ephemeral port allocation, dispose-then-start cycle, max body size (64 KB).

### v2.4.2. Cloudflared spawn

- [ ] **`tunnelBackendCloudflared.open` real impl:**
  - Spawn `cloudflared tunnel --url http://localhost:<port> --no-autoupdate --metrics 127.0.0.1:0`.
  - Scrape stderr на regex `https://[a-z0-9-]+\.trycloudflare\.com`. Timeout 30 с.
  - Watchdog: процесс умер → respawn до 3 раз с exponential backoff. После — `not_available` + alert.
- [ ] Тесты: smoke с fake spawn (mock child_process.spawn).

### v2.4.3. Tailscale spawn

- [ ] **`tunnelBackendTailscale.open` real impl:**
  - Spawn `tailscale funnel --bg <port>`.
  - Polling `tailscale funnel status` каждые 2 с до URL `https://<machine>.<tailnet>.ts.net/`. Timeout 15 с.
  - Cleanup: `tailscale funnel reset` на dispose.
- [ ] Pre-flight: проверить что Funnel включён в ACL (`tailscale funnel status` выдаёт ошибку если нет).

### v2.4.4. webhookTunnel migration

- [ ] **`createAndStartTunnelRelay(handler, type?: TunnelProviderType): Promise<TunnelRelay>`** — high-level helper:
  - `type === "smee"` → existing path (SSE pull).
  - Иначе → start local HTTP server → `openTunnel(type, server.port)` → wire incoming HTTP POST → `handler`.
  - На `not_available` → fallback на smee + warn.
- [ ] **Replace direct calls** в `oneDriveWebhookLifecycle.ts`, `googleDriveWebhookLifecycle.ts` (если использует webhook): `createAndStartSmeeRelay` → `createAndStartTunnelRelay(handler, resolveTunnelType(setting))`.

### v2.4.5. UI + observability

- [ ] **Status-bar:** `$(plug) Tunnel: cloudflared (https://abc.trycloudflare.com)` или `$(plug) Tunnel: smee.io (fallback)`.
- [ ] Команда `vscodesync.showTunnelStatus` → OutputChannel с активным backend, public URL, uptime, restarts count.
- [ ] Auto-restart на network change: hook `vscode.workspace.onDidChangeConfiguration` для `vscodesync.webhooks.tunnelProvider` + reconnect.

---

## v2.6. Декомпозиция `extension.ts` — per-area split

**Текущее состояние:** 4533 LoC в одном файле, 60+ команд. Уже выделены `registerPanels.ts`,
`registerActivitySearches.ts` (≈10 команд). Осталось ≈50.

### v2.6.1. Workspace lifecycle

- [ ] **`src/commands/registerWorkspaceLifecycle.ts`** — `createWorkspace`, `detachWorkspace`, `renameWorkspaceNote`, `editWorkspaceTags`, `suspendWorkspace`, `resumeWorkspace`, `freezeWorkspace`, `unfreezeWorkspace`, `attachCloudWorkspace` (single + multi).

### v2.6.2. File ops

- [ ] **`src/commands/registerFileOps.ts`** — `addFile`, `addFolder`, `removeFile`, `pushCurrentFile`, `pullCurrentFile`, `syncFile`, `forcePullFromMachine`, `pinFileForSync`, `openInCloudStorage`.

### v2.6.3. Conflict resolution

- [ ] **`src/commands/registerConflictResolution.ts`** — `resolveConflicts`, `keepMine`, `takeTheirs`, `keepMineWithRange`, `takeTheirsWithRange`, `treeFileKeepMine`, `treeFileTakeTheirs`, `treeFileForceSync`, `openConflictDiff3way`, `resolveTakeTheirs`.

### v2.6.4. Provider lifecycle

- [ ] **`src/commands/registerProviderLifecycle.ts`** — `setActiveProvider`, `signOut`, `signOutAllProviders`, `migrateToAnotherProvider`, `showProviderSetupGuide`, `connectCloudWorkspace`.

### v2.6.5. Health + diagnostics

- [ ] **`src/commands/registerHealth.ts`** — `showStatus`, `showHealth`, `showStorageReport`, `runHealthCheck`, `showWebhookStatus`, `showTunnelStatus`.

### v2.6.6. Smart features

- [~] **`src/commands/registerSmartFeatures.ts`** — bundle с контрактом `{ context, storageDir }`: `showAchievements` + `installWorkspaceTemplate` (закрыто). Остальные (`aiSessionSummary`, `aiSuggestWorkspaceTags`, `aiPathMapper`, `bulkPush`, `showInsightsWeeklyDigest`, `diffSnapshots`, `openTimeTravelScrubber`) требуют `runWithEngine` / `globalConfig` / `registry` — отдельный файл `registerSmartFeaturesEngine.ts` со своим richer-контрактом, следующая итерация.

### v2.6.7. Validation

- [ ] **CI regression check:** generated `webStubCommands.generated.ts` должен содержать ровно те же command ids, что и до refactor. Diff-fail blocks merge.
- [ ] **`extension.ts < 500 LoC`** после full split — assert в CI.

---

## v2.9. Smart Conflict Prediction — full presence wire

**Текущее состояние:** UI сервис (`SmartConflictPredictionService`) показывает status-bar
warning над soft-lock signal. Это **post-fact** — pred. событий уже произошло.

### v2.9.1. _machines.json schema extension

- [ ] **Расширить `MachineEntry`:** optional `currentEditing: { workspaceId: string; relPath: string; sinceMs: number } | null`. Forward-compat: старые readers игнорируют поле.
- [ ] Schema validator в `manifestValidate.ts` принимает оба shape.

### v2.9.2. Heartbeat propagation

- [ ] **`src/ui/presenceHeartbeat.ts` extension:** в каждом tick читать `vscode.window.activeTextEditor` → если файл tracked → resolve workspaceId → write в `currentEditing`. Если activeEditor нет → write `null`.
- [ ] Throttle: не writes чаще 1× в 30 с независимо от частоты heartbeat.

### v2.9.3. Reader

- [ ] **`SmartConflictPredictionService` reader:** дополнительно к существующему `cfg.files[].editingBy`, читать `_machines.json` через provider раз в 60 с (cached). Объединить с soft-lock записями.
- [ ] Fall-through: если `_machines.json` недоступен (network) → существующий soft-lock fallback.

### v2.9.4. Privacy

- [ ] **Setting** `vscodesync.smartConflictPrediction.broadcastCurrentEditing` (default `true`) — opt-out для пользователей, которые не хотят броадкастить какой файл они открыли.
- [ ] **Anonymise** option: вместо relPath публиковать `workspaceId + sha256(relPath).slice(0,8)` — другие peers видят «alpha editing some-file», но не путь.

### v2.9.5. UX polish

- [ ] **Auto-dismiss:** когда другой machine закрывает файл (sees `currentEditing = null`) — статус-бар скрывается через 60 с (cache TTL).
- [ ] **Pre-save warning:** при `onWillSaveTextDocument` → если risk score > 0.6 → modal «alpha сейчас редактирует. Сохранить всё равно?». Cancel → отменить save.

---

## v2.10. Webhook lifecycle hardening (extracted from Phase 11)

**Текущее состояние:** common expiration helper готов (`webhookExpirationMath.ts`). Полный mock сетевых вызовов lifecycle — отложено.

### v2.10.1. Mock lifecycle test matrix

- [ ] **`tests/unit/oneDriveWebhookLifecycle.test.ts`** — full mock provider: create → renew → expired → recreate cycle. Проверка идемпотентности.
- [ ] **`tests/unit/googleDriveWebhookLifecycle.test.ts`** — то же самое для GDrive Files.watch API.
- [ ] **412 PreconditionFailed** scenarios: `mergeCloudManifests` уже покрыт, добавить EPERM rename, chunk upload (OneDrive Upload Session), smee.io reconnect.

### v2.10.2. Auto-renewal

- [ ] Background timer: за 24 ч до `expiresAt` → renew. Пишет лог в OutputChannel `VSCodeSync · webhooks`.

---

## Состояние

Когда **все** чекбоксы выше закроются — v2 будет fully shipped. Текущее: 0/100+ закрыто
(всё в скелетах / DONE-частях, перечисленных в основном [v2/roadmap.md](roadmap.md)).
