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

- [x] **`src/core/p2pQrExchange.ts`** — pure helpers `planQrChunks(payload, sessionId, chunkLen?)`, `encodeQrChunkLine(chunk)`, `parseQrChunkLine(line)`, `createQrAssembler()`. Wire-format `VSS1|<sid>|<idx>|<total>|<base64>`. Reassembly при out-of-order сканах. 12 unit-тестов. `qrcode-terminal` ^0.12 в `optionalDependencies` для ASCII-рендера.
- [~] UI flow inviter↔invitee multi-step QuickPick + render через `qrcode-terminal` — pure substep controller `createQrExchangeFlow({ role, localPayload, sessionId, chunkLen? })` готов в `src/core/p2pQrExchangeFlow.ts`. Phases: inviter `render_offer → await_answer_scan → decode_answer → done`, invitee `await_offer_scan → render_answer → await_ack → done`. `currentOutboundLine` / `nextOutboundChunk` (round-robin) / `acceptScannedLine` (с rejection paths bad_format / wrong_protocol / session_mismatch / total_mismatch / wrong_phase). 11 unit-тестов. UI рендер через `qrcode-terminal` остаётся.
- [x] Maximum payload: `QR_CHUNK_PAYLOAD_BASE64_LIMIT = 1500` keeps a single QR safely under 2 KB; больше → split на N chunks с sequence number.

### v2.1.3. UI команда «Start P2P session»

- [~] **`vscodesync.startP2PSession`** — pure step planner `planP2PSessionWizard({ role, onlinePeerCount, activeSessionCount, forceQrTransport?, cloudSignalingWritable?, estimatedSignalingPayloadBytes?, qrChunkLimitBytes? })` готов в `src/core/p2pSessionWizardSteps.ts`. Возвращает `{ role, transport: 'cloud' | 'qr', steps[], warnings[] }`. Inviter cloud: 6 шагов (pick_role → pick_target_machine → generate_offer → wait_for_answer → ice_exchange → connection_established). Invitee cloud: 5 шагов (pick_role → pick_active_session → generate_answer → ice_exchange → connection_established). QR variants для air-gapped pair (forceQrTransport=true OR cloudSignalingWritable=false). Abort flow при `onlinePeerCount=0` (inviter) / `activeSessionCount=0` (invitee). Warnings: `no_online_peers` / `no_active_invites` / `qr_oversized_payload` / `transport_fallback_to_qr`. 10 unit-тестов.
- [~] Status-bar widget: «$(broadcast) P2P: 1 peer (alpha)». Click → quick disconnect. Pure formatter `formatP2PStatusBar(snapshot, { commandId?, now? })` готов в `src/core/p2pStatusBarFormatter.ts`. Severity ladder: `ok` ($(broadcast), connected) / `warn` ($(sync~spin), connecting/reconnecting) / `error` ($(error), disconnected) / `off` (idle/undefined). Tooltip — markdown с transport (cloud/QR) / peer label / uptime / последний heartbeat / attempt + next delay. 15 unit-тестов. `vscode.window.createStatusBarItem` обвязка остаётся.
- [~] Auto-disconnect на 5 минут idle. Pure tracker `createP2PIdleTracker({ disconnectAfterMs?, warnAfterMs?, startAtMs? })` готов в `src/core/p2pIdleDisconnect.ts`. `noteFrame(now)` сбрасывает clock, `evaluate(now)` возвращает `continue | warn | disconnect` (idempotent в пределах одного idle-окна). Defaults: 5 мин disconnect / 4 мин warn. 14 unit-тестов. UI обвязка (`setInterval` tick + tear-down DataChannel) остаётся.

### v2.1.4. Файловая передача через P2P

- [x] **`src/core/p2pFileTransfer.ts`** — pure planner `planP2PFileChunks` (16 KB default, last chunk = remainder, empty file = 1 zero-length chunk), `encodeManifestPayload`/`decodeManifestPayload` (strict shape + 16 KB cap), `encodeFileChunkPayload`/`decodeFileChunkPayload` (8-byte BE header: u32 chunkIndex + u32 length). 19 unit-тестов.
- [x] Receiver: `createChunkAssembler(manifest)` — out-of-order delivery, idempotent на duplicates, finalize() возвращает `{ content, hashOk }` (recompute SHA-256 + compare с manifest). Пишет в файл — обвязка наверху (UI layer).
- [~] Hook в `syncEngine.pushFile` — pure planner готов, обвязка к live engine ждёт `vscodesync.startP2PSession` UI команды (v2.1.3, остаётся skeleton).

### v2.1.5. Lifecycle и health

- [x] Heartbeat tick API готов (`onHeartbeatReceived` / `onHeartbeatTick`). `ping` (5) и `pong` (6) зарегистрированы в `P2P_FRAME_TYPE` (`src/core/p2pCryptoEnvelope.ts`) — `wrapAuthenticated.sendFrame("ping", ...)` теперь работает без обвязки. Pure helpers `buildHeartbeatPing(nowMs)` / `buildHeartbeatPong(receivedPing, nowMs)` / `decodeHeartbeatPing(buf)` / `decodeHeartbeatPong(buf)` / `computeHeartbeatRtt(pong, nowMs)` в `src/core/p2pHeartbeatFrames.ts`. Wire format `{ v: 1, sentAtMs, [peerAtMs] }` round-trips для RTT measurement и относительного clock-drift. Strict-decoder rejection paths: `bad_json` / `missing_field` / `bad_field` / `bad_version`. 14 unit-тестов на сами фреймы + 2 round-trip теста через `encodeP2PFrame`/`decodeP2PFrame`.
- [x] Reconnect-on-failure: `src/core/p2pSessionStateMachine.ts` — discriminated-union state machine с exponential backoff (1 s / 2 s / 4 s … cap 30 s, max 5 attempts), события `p2p_session_*` для activity log. 11 unit-тестов.
- [x] Activity log: эмитит события `p2p_session_started / connected / heartbeat_received / heartbeat_lost / reconnect_scheduled / reconnect_giveup / ended` через `events[]`. UI слой подхватит и запишет в `activity.json`.

### v2.1.6. Smoke-test environment

- [x] **`docs/v2/p2p-smoke-guide.md`** — manual reproduction guide; перечисление 8 pure модулей, инструкция собрать end-to-end сессию (offer → answer → ICE → DataChannel → file chunks → cleanup), pass criteria.
- [ ] CI smoke в single-process mode через `@roamhq/wrtc` — blocked: native binding на CI runner ненадёжен, ICE timing для vitest-default 5s timeout слишком тугой.

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

- [x] **5 одноразовых recovery codes** — `src/core/passkeyRecoveryCodes.ts`: `generateRecoveryCodes(count?)` (default 5, max 50) формат `xxxx-xxxx-xxxx-xxxx-xxxx` (28-symbol alphabet без 0/o/1/i/l). `hashRecoveryCode` нормализует case+dashes+whitespace перед SHA-256. `verifyRecoveryCode(code, hashes)` constant-time match, пропускает consumed (`""`). 7 unit-тестов.
- [~] **Passphrase fallback** — pure step planner `planPassphraseFlow({ mode, hasEnrolledPassphrase, strengthScore?, recentFailedAttempts?, maxAttempts?, lockoutStartedAtMs?, lockoutDurationMs?, nowMs })` готов в `src/core/passphraseFallbackFlow.ts`. 3 modes (`enroll` / `unlock` / `recover`) × 4 warnings (`no_passphrase_enrolled` / `weak_passphrase_strength` < 0.5 / `lockout_active` / `near_lockout` ≤ 1 attempt). 5-attempt default with 5-min lockout, expired lockout автоматически clears. 13 unit-тестов. UI обвязка остаётся.
- [~] **Multi-device** — мульти-credential map. `src/core/passkeyCredentialRegistry.ts`: `PasskeyCredentialRegistry { version: 1, entries[], primaryId? }` + pure helpers `upsertCredential` / `removeCredential` / `setPrimaryCredential` / `findPrimaryCredential` (fallback to most-recent enrolled) / `findCredentialById` / `orderForDisplay` (primary → recency) / `noteCredentialUsed` + strict `parsePasskeyRegistry` (rejection: `bad_root_shape` / `bad_version` / `bad_entries` / `bad_entry_shape` / `bad_primary_id`). 28 unit-тестов. SecretStorage-обвязка остаётся.

### v2.2.5. Settings UI

- [~] **`vscodesync.showPasskeySettings`** — pure formatter `renderPasskeyDevicesHtml(devices, { formatDate?, title?, styleNonce? })` готов в `src/core/passkeyDevicesFormatter.ts`. Renders device list (sorted by enrolledAtMs desc, "never" placeholder для unused devices, action buttons rename/remove с `data-action` / `data-id`). XSS-safe (every interpolation через `escapeHtml`). `parseDeviceUserAgent(uaString)` — heuristic для derive friendly label "Chrome 124 on macOS 14.2" (Edge before Chrome detection, Safari/iOS/Android/Linux/Windows + macOS supported, fallback "Unknown device"). 13 unit-тестов. Webview controller + onDidReceiveMessage обвязка остаётся.

### v2.2.6. Tests + telemetry

- [x] Unit-тесты на envelope wrap/unwrap — `src/core/passkeyEnvelopeWrap.ts` с инжекцией `DeriveKekFn(credentialId, salt) → Uint8Array`. AES-256-GCM, authTag append к ciphertext (без расширения `KeyEnvelope` shape). 5 unit-тестов с deterministic mock derive: round-trip, auth_failure при mismatched derive, shape rejection.
- [~] Telemetry: track WebAuthn failure reasons — pure event-shape `PasskeyTelemetryEvent` (discriminated union: enroll_success / enroll_failure / unlock_success / unlock_failure / removal / recovery_code_used / passphrase_fallback_used) + `toUsagePayload(event)` → `{ name, data }` готовы в `src/core/passkeyTelemetryEvents.ts`. Sanitiser: failure-reason taxonomy с fallback `"unknown"` — никогда не сериализуется raw exception text; clamp counters; PII (credential id, raw UA) недоступна по типу. 14 unit-тестов. Wire через существующий `vscode.TelemetryLogger.logUsage` остаётся.

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

- [~] Default workflow: pure decision helper `planBlake3MigrationAction({ currentSetting, dualWorkflowStartedMs, nowMs, gracePeriodMs?, completedRatio, recommendThreshold? })` готов в `src/core/blake3MigrationDecision.ts`. 4 actions (`stay_sha256` / `stay_dual` / `recommend_switch` / `safe_to_switch_now`) × 7 reasons (`setting_off` / `setting_already_blake3` / `no_workflow_started` / `grace_pending` / `coverage_too_low` / `threshold_reached` / `full_coverage`). Default grace 7 дней, default threshold 95% coverage. 10 unit-тестов. Engine-side hook (показ toast + flip setting) остаётся.
- [~] **Команда `vscodesync.completeBlake3Migration`** — pure planner ready: `planBlake3MigrationTasks(workspaces[])` в `src/core/hashMigrationCheck.ts` возвращает упорядоченный список `{ workspaceId, relPath, existingSha256 }`. Engine wiring (читать `_meta.json` всех workspace, для каждого task recompute BLAKE3 локально + write meta back) остаётся.

### v2.3.5. Performance + telemetry

- [x] `docs/v2/blake3-benchmark.md` + `scripts/benchmarks/blake3-bench.mjs`. Markdown-friendly bench script (4 workspace sizes 10×5KB, 100×50KB, 100×500KB, 10×5MB), warm-up + perf_hooks timing, sample numbers + when-to-switch guidance + dual-hash workflow.
- [x] Activity log: `kind: "hash_migration"` зарегистрирован в `ActivityKind` union.

---

## v2.4. Cloudflare / Tailscale tunnel — full spawn + webhookTunnel migration

**Текущее состояние:** оба backend'а — skeleton'ы (probe binary, return `not_available`).
Зарегистрированы в registry. `webhookTunnel.ts` всё ещё вызывает `createAndStartSmeeRelay` напрямую.

### v2.4.1. Local HTTP server абстракция

- [x] **`src/ui/webhookLocalServer.ts`** — provider-agnostic abstraction. `startLocalWebhookServer({ port?, host?, maxBodyBytes?, handler })` → `{ port, dispose() }`. Handler receives `{ method, url, headers (lowercase keys), body: Buffer }` и возвращает `{ status, body?, contentType?, headers? }`. Идемпотентный dispose, 64 KB DoS-cap по-умолчанию, 413 на превышение, 500 при throw из handler.
- [x] Тесты: ephemeral port allocation, dispose-then-start cycle, max body size, 413 на oversized, 500 на handler throw, header lowercasing, body echo. 7 unit-тестов.

### v2.4.2. Cloudflared spawn

- [~] **`tunnelBackendCloudflared.open` real impl:** pure URL-scrape ready (`src/core/tunnelUrlScrape.ts:scrapeTunnelUrl(buf, "cloudflared")` + `isValidTunnelUrl`); pure spawn watchdog state machine ready (`src/core/tunnelSpawnWatchdog.ts:createTunnelSpawnWatchdog`); spawn-обвязка остаётся (нет binary на dev-машине).
  - Spawn `cloudflared tunnel --url http://localhost:<port> --no-autoupdate --metrics 127.0.0.1:0`.
  - Scrape stderr на regex `https://[a-z0-9-]+\.trycloudflare\.com`. Timeout 30 с.
  - Watchdog: discriminated-union state machine `idle → spawning → up → respawning → giveup`, exponential backoff (1 s / 2 s / 4 s … cap 30 s, max 3 attempts по-умолчанию), failure reasons `process_exit | url_timeout | spawn_failed`. 15 unit-тестов. Реальная обвязка `child_process.spawn` остаётся.
- [x] Тесты на pure scrape логику (`tests/unit/tunnelUrlScrape.test.ts`, 9 тестов с real-world stderr/stdout fixtures без spawn). Полный smoke с fake spawn остаётся (нужен mock `child_process.spawn` который завершит через event-loop tick).

### v2.4.3. Tailscale spawn

- [~] **`tunnelBackendTailscale.open` real impl:** pure URL-scrape ready (`scrapeTunnelUrl(buf, "tailscale-funnel")` + `isValidTunnelUrl` принимает `https://*.ts.net` с/без trailing slash); `tailscale funnel <port>` spawn + polling `tailscale funnel status` остаётся.
  - Spawn `tailscale funnel --bg <port>`.
  - Polling `tailscale funnel status` каждые 2 с до URL `https://<machine>.<tailnet>.ts.net/`. Timeout 15 с.
  - Cleanup: `tailscale funnel reset` на dispose.
- [~] Pre-flight: проверить что Funnel включён в ACL (`tailscale funnel status` выдаёт ошибку если нет). Pure parser `parseTailscaleFunnelStatus(text)` готов в `src/core/tailscaleFunnelAclParser.ts`. Возвращает `{ ok:true, enabled, listeningUrls? }` или `{ ok:false, reason: 'acl_denied' | 'not_logged_in' | 'daemon_unavailable' | 'unknown', hint }`. Distinct rejection paths (ACL, not-logged-in, daemonless, empty/gibberish), URL dedup, multi-host extraction. 13 unit-тестов. Spawn-обвязка остаётся.

### v2.4.4. webhookTunnel migration

- [x] **`createAndStartTunnelRelay(options): Promise<TunnelRelayHandle | undefined>`** — `src/ui/tunnelRelayDispatcher.ts`. Setting `"smee"` → дефолтный SSE-relay; иначе → `startLocalWebhookServer` + `openTunnel`. Fallback на smee при `not_available` / `config_invalid` / `spawn_failed` / local-server bind failure (если `noFallback: true` — возвращает `undefined`). Lazy-import smee модуля чтобы юнит-тесты не тянули vscode. Тесты с overrides на `openTunnel` / `localServerFactory` / `smeeRelayOverride`. 9 unit-тестов.
- [ ] **Replace direct calls** в `oneDriveWebhookLifecycle.ts`, `googleDriveWebhookLifecycle.ts`: миграция на `createAndStartTunnelRelay` остаётся следующей итерацией (требует обвязки и обновления интеграционных тестов).

### v2.4.5. UI + observability

- [~] **Status-bar:** widget pure formatter `formatTunnelStatusBar(snapshot, { commandId?, now? })` готов в `src/core/tunnelStatusBarFormatter.ts`. Возвращает `{ text, tooltip, severity, commandId }`. Severity ladder: `ok` ($(plug), no fallback) / `warn` ($(warning), requested ≠ effective OR lastFallbackReason set) / `error` ($(error), restartCount ≥ 3). Tooltip — markdown с public URL, requested/active providers, uptime, restart count, last fallback (omitted when undefined). Inactive snapshot → "Tunnel: off". 12 unit-тестов. `vscode.window.createStatusBarItem` обвязка остаётся.
- [x] **Команда `vscodesync.showTunnelStatus`** → OutputChannel `VSCodeSync · Tunnel` с rendered `formatTunnelStatusReport(getTunnelStatus())`. Backend `tunnelStatusRegistry.ts` (pure module) обновляется dispatcher'ом на каждый relay open / fallback / dispose. Уптайм формата `1h 2m 3s`. 9 unit-тестов на registry + format.
- [x] Pure decision helper `src/core/tunnelConfigWatcher.ts` — `compareTunnelConfig(prev, next)` возвращает `{ action: 'no_change' | 'start' | 'stop' | 'restart', reason }`. Триггеры: tunnel enabled/disabled, provider change, URL change. 8 unit-тестов. Engine-side подписка на `onDidChangeConfiguration` остаётся следующей итерацией (pure decision готов).

---

## v2.6. Декомпозиция `extension.ts` — per-area split

**Текущее состояние:** **2486 LoC, 0 inline-команд осталось.** Стартовый счёт был 5085 LoC / 87 команд; за серию commits (e5f1d8a → следующий) вынесено **все 87 команд** в 13 per-area `register*.ts` модулей с единым `Deps`-контрактом. Helpers `pickRoot` / `pickWorkspaceId` / `pickWorkspaceIdMatching` / `pickOtherWorkspaceId` / `validateWorkspaceTransition` подняты в `src/commands/_shared.ts`. `RunWithEngineFn` typed alias в `registerWorkspaceLifecycle.ts` переиспользуется всеми bundle'ами. Tests 1604/1604, lint=0 на каждом этапе. Что осталось в extension.ts (2486 LoC) — startup wiring (config / registry / watchers / event handlers), helper functions (`makeEngine`, `runWithEngine`, `ensureProvider`, OAuth closures), `activate()` / `deactivate()` orchestration.

### v2.6.1. Workspace lifecycle

- [x] **`src/commands/registerWorkspaceLifecycle.ts`** — 8 команд (suspend/resume/freeze/unfreeze/archive/unarchive/deleteFromCloud/purge). Helpers `pickRoot` / `pickWorkspaceId*` / `validateWorkspaceTransition` подняты в `_shared.ts`. Commit `a0b8662`.

### v2.6.2. File ops

- [x] **`src/commands/registerFileOperations.ts`** — 12 команд (addCurrentFile/addFolder/addToNew/removeFromSync/pushCurrent/pullCurrent/move/diff/showHistory/timeTravel/openInCloud/pin). `runAddToNewWorkspace` / `showFileHistoryAt` / `openTrackedFileInCloudStorageAt` через callback deps. Commit `c3b28a0`.

### v2.6.3. Conflict resolution

- [x] **`src/commands/registerConflicts.ts`** — 8 команд (keepMine/takeTheirs + WithRange variants / openConflictDiff3way / resolveTakeTheirs / resolveKeepMine / resolveConflicts). Shared `notifiedConflictKeys` Set передаётся через deps. `runConflict3WayDiffAt` / `runAiMergeForConflictAt` через callbacks. Commit `bd80208`.

### v2.6.4. Provider lifecycle

- [x] **`src/commands/registerProviderSignIn.ts`** — 10 команд (setActiveProvider + 4×(SignIn / SignInHeadless) + yandexEnterToken). `runOneDriveAuth/etc` closures передаются через `signIn.<provider>` callbacks. Commit `e5f1d8a`.

### v2.6.5. Health + diagnostics

- [x] **Полностью закрыто.** `src/commands/registerSettings.ts` (5 команд: setNotificationLevel/showStatus/openSyncSettings/toggleTelemetry/showSyncSummary, commit `8d0098e`) + `src/commands/registerViewManagement.ts` (8 команд, commit `bac76ea`) + `src/commands/registerHeavyMisc.ts` (4 команды: setGitBranchWorkspace/repairState/previewSync/startOnboarding) + `src/commands/registerDiagnostics.ts` (2 команды: takeSyncOwnership/healthCheck) + `src/commands/registerWorkspaceCreate.ts` (2 команды: createWorkspace/connectCloudWorkspace, плюс fix bug с undeclared `connected` variable).

### v2.6.6. Smart features

- [~] **`src/commands/registerSmartFeatures.ts`** — bundle с контрактом `{ context, storageDir }`: `showAchievements` + `installWorkspaceTemplate` (закрыто). `bulkPush` теперь в `registerSyncOps.ts` (commit `e7a5787`). Остальные (`aiSessionSummary`, `aiSuggestWorkspaceTags`, `aiPathMapper`, `showInsightsWeeklyDigest`, `diffSnapshots`, `openTimeTravelScrubber`) требуют `runWithEngine` / `globalConfig` / `registry` — отдельный файл `registerSmartFeaturesEngine.ts` со своим richer-контрактом, следующая итерация.

### v2.6.7. Validation

- [x] **CI regression check:** `tests/unit/packageJsonCommandsConsistency.test.ts` — assert каждый `contributes.commands[].command` присутствует в `WEB_STUB_COMMAND_IDS` + no-duplicates check. Если refactor забывает зарегистрировать команду в одном из мест — тест падает.
- [~] **`extension.ts < 500 LoC` assert** — текущий **2486 LoC** (87 / 87 inline-команд = 100% extracted). Оставшиеся ~2400 — `makeEngine` / `runWithEngine` factory / `ensureProvider` / `tryAuthenticatedProvider` / OAuth closures (`runOneDriveAuth` / etc) / `getEncKey` / startup-wiring (config load, registry init, watchers, event handlers) / helper functions (`buildInlineDiff`, `makeOnFilePulledCallback`, `runShowFileHistory`, `runConflict3WayDiff`, etc.). Снижение до < 500 LoC требует подъёма factory pattern (`createRunWithEngine`/`createMakeEngine`) в `src/commands/_engineFactory.ts` + миграции OAuth closures в shared module + декомпозиции startup-wiring (например `src/startup/registerLifecycle.ts`).

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

- [x] **Auto-dismiss:** `src/core/presenceCacheTTL.ts` — TTL cache (60 s default), entries evict on each `get` / `list` / `evict`. UI service `SmartConflictPredictionService` подключает кэш и автоматически прячет warning через 60 с idle.
- [x] **Pre-save warning helper:** `findHighRiskPeer({ cache, myWorkspaceId, myRelPath, myAnonymised?, threshold? })` возвращает `{ entry, risk } | null` для `onWillSaveTextDocument` modal. `PRE_SAVE_RISK_THRESHOLD = 0.6`. UI обвязка — следующая итерация. 9 unit-тестов.

---

## v2.10. Webhook lifecycle hardening (extracted from Phase 11)

**Текущее состояние:** common expiration helper готов (`webhookExpirationMath.ts`). Полный mock сетевых вызовов lifecycle — отложено.

### v2.10.1. Mock lifecycle test matrix

- [~] Full mock matrix для `oneDriveWebhookLifecycle.ts` / `googleDriveWebhookLifecycle.ts` — pure decision tree выделен в `src/core/webhookLifecycleReconcileDecision.ts:planWebhookLifecycleReconcile(input)`. Возвращает `{ actions[], lifecycleActive, inactiveReason? }` с discriminated-union actions (`delete_stale_subscription` / `clear_local_state` / `start_local_server` / `create_subscription` / `keep_subscription` / `register_webhook_push` / `start_renew_loop`). Покрывает 4 inactiveReasons (`provider_mismatch` / `webhooks_disabled` / `no_notification_url` / `no_token`) + URL-drift recreate с переиспользованием clientState. 14 unit-тестов. Wrapper в `oneDriveWebhookLifecycle.ts` / `googleDriveWebhookLifecycle.ts` остаётся переписать на pure planner.
- [~] **412 PreconditionFailed** edge-cases (EPERM rename, OneDrive Upload Session chunk, smee.io reconnect) — pure renewTick decision выделен в `src/core/webhookLifecycleRenewTickDecision.ts:decideWebhookRenewTick(input)` и подключён в `oneDriveWebhookLifecycle.renewTick` + `googleDriveWebhookLifecycle.renewTick`. Strict envelope decoders подключены в `graphWebhookSubscription.ts:graphCreateDriveRootSubscription/graphRenewSubscription` + `gdrivePushChannelApi.ts:gdriveStartFolderWatch`. Mock matrix для остальных edge-cases (412 + EPERM rename + smee reconnect) всё ещё требует полного рефакторинга `reconcileBody` на adapter pattern поверх `planWebhookLifecycleReconcile`.

### v2.10.2. Auto-renewal

- [x] Pure planner `src/core/webhookAutoRenewal.ts` — `planWebhookRenewal(subscriptions, now?, slackMs?)` возвращает `actions[]` (`renew_now` / `expired_recreate` / `wait_until` с `nextDueMs`) + `nextWakeMs` (раннее время для `setTimeout`). Использует существующий `isNearOrPastExpiration` (slack 20 мин). 6 unit-тестов.
- [x] Pure loop driver `src/core/webhookRenewalLoop.ts` — `createWebhookRenewalLoop({ fetchSubscriptions, onRenew, onRecreate, onLog?, scheduler? })`. Использует `planWebhookRenewal` для решения, на каждый `renew_now` / `expired_recreate` вызывает callback, на `wait_until` — `setTimer(nextDueMs - now)` с min 60 s / max 1 hour bounds. Inject-able scheduler для тестов. 6 unit-тестов с manual scheduler. Engine-side wiring (`fetchSubscriptions` из oneDriveLifecycle/googleDriveLifecycle, OutputChannel `VSCodeSync · webhooks`) — следующая итерация (loop driver ready).

---

## Состояние

Когда **все** чекбоксы выше закроются — v2 будет fully shipped. Текущее: 0/100+ закрыто
(всё в скелетах / DONE-частях, перечисленных в основном [v2/roadmap.md](roadmap.md)).
