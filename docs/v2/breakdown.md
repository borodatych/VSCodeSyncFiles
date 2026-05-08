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

- [~] Heartbeat tick API готов (`onHeartbeatReceived` / `onHeartbeatTick`) — фактический wire `sendFrame("ping", ...)` ждёт регистрации `ping` в P2P_FRAME_TYPE и обвязки в `wrapAuthenticated`.
- [x] Reconnect-on-failure: `src/core/p2pSessionStateMachine.ts` — discriminated-union state machine с exponential backoff (1 s / 2 s / 4 s … cap 30 s, max 5 attempts), события `p2p_session_*` для activity log. 11 unit-тестов.
- [x] Activity log: эмитит события `p2p_session_started / connected / heartbeat_received / heartbeat_lost / reconnect_scheduled / reconnect_giveup / ended` через `events[]`. UI слой подхватит и запишет в `activity.json`.

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

- [x] **Setting** `vscodesync.canonicalHashAlgo`: `"sha256"` (default) | `"blake3"` | `"dual"`. Описание + RU локализация в `package.nls.{json,ru.json}`.
- [x] **Расширить `MetaEntry`:** добавлено optional `hashBlake3?: string` в `cloudLayout.ts`. Forward-compat — старые readers игнорируют unknown field.

### v2.3.2. Dual-hash writer

- [x] **`computeHashDual`** — pure helper в `hashProviders.ts`: возвращает `{ sha256: string; blake3: string }`. При отсутствии BLAKE3 backend'а fallback к sha256 в обоих полях.
- [~] **`pushFile` writes both** — pure helper готов; обвязка в `syncEngine.pushFile` для записи обоих в meta остаётся следующей итерации (требует чтения текущего setting'а через `runWithEngine` deps).

### v2.3.3. Reader compatibility

- [x] **`compareMetaHash` extended** — pure helper в `hashProviders.ts`: если manifest имеет `hashBlake3` и preferred=`blake3` → сравнивает blake3, иначе fallback на sha256 (всегда есть). 5 unit-тестов.
- [x] **Migration check at startup** — `runHashAlgoMigrationCheck` в `src/core/hashMigrationCheck.ts`: pure helper над списком workspaces+entries, возвращает per-workspace ratio + global `safeToSwitchToBlake3`. 5 unit-тестов.

### v2.3.4. Transition window

- [ ] Default workflow: пользователь ставит setting `dual` → next sync пишет оба хеша → через 7 дней (или command «complete migration») setting → `blake3` → старые sha256-only meta entries lazily upgrade на следующий push.
- [ ] **Команда `vscodesync.completeBlake3Migration`** — фоновая задача: для каждого workspace, для каждого файла без `hashBlake3` → recompute и write meta (без download blob — берём local hash, поскольку local hash должен совпадать).

### v2.3.5. Performance + telemetry

- [ ] Бенчмарк-тесты: типичный workspace (100 файлов × 50 KB) — sha256 vs blake3 wall-time. Опубликовать в `docs/v2/blake3-benchmark.md` (skeleton — нужно реальное измерение на машине пользователя).
- [x] Activity log: `kind: "hash_migration"` зарегистрирован в `ActivityKind` union.

---

## v2.4. Cloudflare / Tailscale tunnel — full spawn + webhookTunnel migration

**Текущее состояние:** оба backend'а — skeleton'ы (probe binary, return `not_available`).
Зарегистрированы в registry. `webhookTunnel.ts` всё ещё вызывает `createAndStartSmeeRelay` напрямую.

### v2.4.1. Local HTTP server абстракция

- [x] **`src/ui/webhookLocalServer.ts`** — provider-agnostic abstraction. `startLocalWebhookServer({ port?, host?, maxBodyBytes?, handler })` → `{ port, dispose() }`. Handler receives `{ method, url, headers (lowercase keys), body: Buffer }` и возвращает `{ status, body?, contentType?, headers? }`. Идемпотентный dispose, 64 KB DoS-cap по-умолчанию, 413 на превышение, 500 при throw из handler.
- [x] Тесты: ephemeral port allocation, dispose-then-start cycle, max body size, 413 на oversized, 500 на handler throw, header lowercasing, body echo. 7 unit-тестов.

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

- [x] **`createAndStartTunnelRelay(options): Promise<TunnelRelayHandle | undefined>`** — `src/ui/tunnelRelayDispatcher.ts`. Setting `"smee"` → дефолтный SSE-relay; иначе → `startLocalWebhookServer` + `openTunnel`. Fallback на smee при `not_available` / `config_invalid` / `spawn_failed` / local-server bind failure (если `noFallback: true` — возвращает `undefined`). Lazy-import smee модуля чтобы юнит-тесты не тянули vscode. Тесты с overrides на `openTunnel` / `localServerFactory` / `smeeRelayOverride`. 9 unit-тестов.
- [ ] **Replace direct calls** в `oneDriveWebhookLifecycle.ts`, `googleDriveWebhookLifecycle.ts`: миграция на `createAndStartTunnelRelay` остаётся следующей итерацией (требует обвязки и обновления интеграционных тестов).

### v2.4.5. UI + observability

- [ ] **Status-bar:** widget с эмодзи `$(plug)` и активным backend — отдельная итерация (зависит от `tunnelStatusRegistry` events; пока команда даёт текстовый отчёт).
- [x] **Команда `vscodesync.showTunnelStatus`** → OutputChannel `VSCodeSync · Tunnel` с rendered `formatTunnelStatusReport(getTunnelStatus())`. Backend `tunnelStatusRegistry.ts` (pure module) обновляется dispatcher'ом на каждый relay open / fallback / dispose. Уптайм формата `1h 2m 3s`. 9 unit-тестов на registry + format.
- [ ] Auto-restart на network change остаётся следующей итерацией (требует engine-level lifecycle и reactive subscription на configChange).

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

- [x] **Расширил `MachineEntry`:** optional `currentEditing: { workspaceId, relPath, sinceMs } | null` в `cloudLayout.ts`. Forward-compat — старые readers игнорируют поле.
- [x] Schema validator в `manifestValidate.ts` accepts both shapes — `undefined` / `null` / валидный объект, отвергает мусор.

### v2.9.2. Heartbeat propagation

- [x] Pure helpers в `src/core/presenceCurrentEditing.ts`: `buildCurrentEditingFrame({ workspaceId, relPath, nowMs, mode })`, `shouldBroadcastCurrentEditing({ last, next, nowMs, throttleMs? })` (throttle 30 s по-умолчанию). Обвязка к `presenceHeartbeat.ts` (read activeTextEditor) — следующая итерация.

### v2.9.3. Reader

- [x] `scorePresenceRisk({ myWorkspaceId, myRelPath, myAnonymised?, peerCurrentEditing })` — pure scorer, returns 0..1. Полная обвязка `SmartConflictPredictionService` к чтению `_machines.json` каждые 60 с — следующая итерация (нужен ICloudProvider injection).

### v2.9.4. Privacy

- [x] **Setting** `vscodesync.smartConflictPrediction.broadcastCurrentEditing` — `"full" | "anonymised" | "off"` (default `"full"`). Описание + RU локализация.
- [x] **Anonymise** option реализован в `buildCurrentEditingFrame` — режим `"anonymised"` пишет `sha256(relPath).slice(0,8)`. Peer-side `scorePresenceRisk` принимает опциональный `myAnonymised` для сравнения.

### v2.9.5. UX polish

- [ ] **Auto-dismiss:** TTL для cached presence — следующая итерация (engine-side timer).
- [ ] **Pre-save warning:** `scorePresenceRisk > 0.6` → modal на `onWillSaveTextDocument`. Pure scorer ready; обвязка остаётся.

---

## v2.10. Webhook lifecycle hardening (extracted from Phase 11)

**Текущее состояние:** common expiration helper готов (`webhookExpirationMath.ts`). Полный mock сетевых вызовов lifecycle — отложено.

### v2.10.1. Mock lifecycle test matrix

- [ ] Full mock matrix для `oneDriveWebhookLifecycle.ts` / `googleDriveWebhookLifecycle.ts` — оба модуля импортируют `vscode` напрямую (showWarningMessage и т.п.); честные мок-тесты требуют рефакторинга на vscode-free pure-core + thin wrapper. Skeleton — следующая итерация.
- [ ] **412 PreconditionFailed** edge-cases (EPERM rename, OneDrive Upload Session chunk, smee.io reconnect) — те же блокеры (зависят от рефакторинга lifecycle модулей).

### v2.10.2. Auto-renewal

- [x] Pure planner `src/core/webhookAutoRenewal.ts` — `planWebhookRenewal(subscriptions, now?, slackMs?)` возвращает `actions[]` (`renew_now` / `expired_recreate` / `wait_until` с `nextDueMs`) + `nextWakeMs` (раннее время для `setTimeout`). Использует существующий `isNearOrPastExpiration` (slack 20 мин). 6 unit-тестов.
- [ ] Подключение `setInterval`-таймера в extension.ts + лог в `VSCodeSync · webhooks` OutputChannel остаётся следующей итерацией.

---

## Состояние

Когда **все** чекбоксы выше закроются — v2 будет fully shipped. Текущее: 0/100+ закрыто
(всё в скелетах / DONE-частях, перечисленных в основном [v2/roadmap.md](roadmap.md)).
