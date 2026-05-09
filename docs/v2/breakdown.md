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
- [x] Hook в `syncEngine.pushFile` — `SyncEngineDeps.onPushFile?: (workspaceId, posixRel, plaintext, meta)` callback вызывается после успешного `pushMetaJson`. Errors swallowed (best-effort mirror). P2P UI runtime (v2.12.4) может подписаться без рефакторинга engine API.

### v2.1.5. Lifecycle и health

- [x] Heartbeat tick API готов (`onHeartbeatReceived` / `onHeartbeatTick`). `ping` (5) и `pong` (6) зарегистрированы в `P2P_FRAME_TYPE` (`src/core/p2pCryptoEnvelope.ts`) — `wrapAuthenticated.sendFrame("ping", ...)` теперь работает без обвязки. Pure helpers `buildHeartbeatPing(nowMs)` / `buildHeartbeatPong(receivedPing, nowMs)` / `decodeHeartbeatPing(buf)` / `decodeHeartbeatPong(buf)` / `computeHeartbeatRtt(pong, nowMs)` в `src/core/p2pHeartbeatFrames.ts`. Wire format `{ v: 1, sentAtMs, [peerAtMs] }` round-trips для RTT measurement и относительного clock-drift. Strict-decoder rejection paths: `bad_json` / `missing_field` / `bad_field` / `bad_version`. 14 unit-тестов на сами фреймы + 2 round-trip теста через `encodeP2PFrame`/`decodeP2PFrame`.
- [x] Reconnect-on-failure: `src/core/p2pSessionStateMachine.ts` — discriminated-union state machine с exponential backoff (1 s / 2 s / 4 s … cap 30 s, max 5 attempts), события `p2p_session_*` для activity log. 11 unit-тестов.
- [x] Activity log: эмитит события `p2p_session_started / connected / heartbeat_received / heartbeat_lost / reconnect_scheduled / reconnect_giveup / ended` через `events[]`. UI слой подхватит и запишет в `activity.json`.

### v2.1.6. Smoke-test environment

- [x] **`docs/v2/p2p-smoke-guide.md`** — manual reproduction guide; перечисление 8 pure модулей, инструкция собрать end-to-end сессию (offer → answer → ICE → DataChannel → file chunks → cleanup), pass criteria.
- [x] CI smoke в single-process mode через `@roamhq/wrtc` — `tests/unit/p2pSessionRuntime.smoke.test.ts` (opt-in через `P2P_SMOKE=1` env) + `.github/workflows/p2p-smoke.yml` (hosted-non-blocking + self-hosted optional с label `p2p-smoke`). Vitest timeout bumped до 30 s для cold-start dynamic-import. Sentinel-test (без binding) всегда проходит для регресс-cover.

---

## v2.2. Passkey / WebAuthn — разлок ключа шифрования

**Текущее состояние:** envelope-shape готов в `keyEnvelope.ts`. `deriveWebauthnKek`
бросает sentinel.

### v2.2.1. Web platform (browser, vscode.dev)

- [x] **`deriveWebauthnKek` real impl (web)** — `src/ui/webauthnWebview.ts:runWebAuthnEnroll` / `runWebAuthnUnlock` запускают one-shot webview с `navigator.credentials.create/.get({publicKey, extensions: { prf } })`. PRF.eval.first вернёт 32 байта pseudo-random material → `deriveWebauthnKek` (HKDF-SHA256) в `src/core/keyEnvelope.ts` чейнит в KEK. Webview работает и в vscode.dev, и в desktop Chromium.
- [x] **Storage:** credential id хранится в `PasskeyRegistryStorage` поверх SecretStorage (`src/ui/passkeyRegistryStorage.ts`); `prfSaltHex` записывается в `meta.prfSaltHex` envelope'а в SecretStorage. KEK не персистится — выводится из PRF при каждом unlock'е.

### v2.2.2. Desktop platform (electron / vscode native)

- [x] **Native FIDO2 через webview API** — `runWebAuthnEnroll/Unlock` в `webauthnWebview.ts` создаёт Chromium-backed webview, который Electron forward'ит в OS FIDO2 stack (Windows Hello / Touch ID / hardware keys) автоматически. CSP nonce + sandboxed script.
- [~] Альтернатива: native binding — typed `WebAuthnAdapter` + `makeSkeletonWebAuthnAdapter` sentinel in `src/core/webauthnPlatformAdapter.ts` (commit `c45337d`). Lazy loader `src/core/nativeFido2Probe.ts:probeNativeFido2` пытается load opt-in candidates (default — пустой список); 5 unit-тестов на module_not_installed / module_load_failed / success-with-mock-loader / candidate priority. Реальный wire-up `node-webauthn` / `fido2-lib` остаётся (нужен FIDO2 toolchain в OS — постинсталл может падать).

### v2.2.3. UI flow

- [x] **Команда `vscodesync.enrollPasskey`** — `src/ui/passkeyCommands.ts:runEnrollPasskey` (commit `0733329` + DEK rewrap из run 24): `runWebAuthnEnroll` → `wrapDekForWebauthn` → `storeWebauthnEnvelope` поверх существующего DEK; запись в `PasskeyRegistryStorage`.
- [x] **Команда `vscodesync.unlockWithPasskey`** — `src/ui/passkeyCommands.ts:runUnlockWithPasskey`: replays `meta.prfSaltHex` envelope'а → `runWebAuthnUnlock` → `unwrapDekFromWebauthn` → `storeEncryptionKey` обратно в SecretStorage. Touch'ит `lastUsedAtMs` на credential.
- [x] **Команда `vscodesync.removePasskey`** — palette QuickPick + confirm modal + telemetry; storage в `passkeyRegistryStorage.ts` (commit `0733329`).

### v2.2.4. Recovery + fallback

- [x] **5 одноразовых recovery codes** — `src/core/passkeyRecoveryCodes.ts`: `generateRecoveryCodes(count?)` (default 5, max 50) формат `xxxx-xxxx-xxxx-xxxx-xxxx` (28-symbol alphabet без 0/o/1/i/l). `hashRecoveryCode` нормализует case+dashes+whitespace перед SHA-256. `verifyRecoveryCode(code, hashes)` constant-time match, пропускает consumed (`""`). 7 unit-тестов.
- [x] **Passphrase fallback** — `vscodesync.passkeyFallback` command exposes the wizard via QuickPick (`src/ui/passkeyCommands.ts`, commit `0733329`). Real enroll/unlock paths gated behind v2.2.1 WebAuthn impl.
- [x] **Multi-device** — `src/ui/passkeyRegistryStorage.ts` round-trip via SecretStorage (commit `0733329`); strict-decoder rejection paths surface via `warnLog`.

### v2.2.5. Settings UI

- [x] **`vscodesync.showPasskeySettings`** — webview controller + `onDidReceiveMessage` for rename / remove actions wired in `src/ui/passkeyCommands.ts` (commit `0733329`).

### v2.2.6. Tests + telemetry

- [x] Unit-тесты на envelope wrap/unwrap — `src/core/passkeyEnvelopeWrap.ts` с инжекцией `DeriveKekFn(credentialId, salt) → Uint8Array`. AES-256-GCM, authTag append к ciphertext (без расширения `KeyEnvelope` shape). 5 unit-тестов с deterministic mock derive: round-trip, auth_failure при mismatched derive, shape rejection.
- [x] Telemetry: WebAuthn failure reasons wired via module-level `logSanitisedUsage` in `extensionTelemetry.ts` (commit `0733329`). Wave B passkey commands dispatch removal + passphrase_fallback_used events.

---

## v2.3. BLAKE3 migration с dual-hash transition

**Текущее состояние:** BLAKE3 backend подключён, `selectHashProvider` готов.
Switch SHA-256 → BLAKE3 в `computeHash` сломает совместимость со старыми манифестами.

### v2.3.1. Setting + hash field

- [x] **Setting** `vscodesync.canonicalHashAlgo`: `"sha256"` (default) | `"blake3"` | `"dual"`. Описание + RU локализация в `package.nls.{json,ru.json}`.
- [x] **Расширить `MetaEntry`:** добавлено optional `hashBlake3?: string` в `cloudLayout.ts`. Forward-compat — старые readers игнорируют unknown field.

### v2.3.2. Dual-hash writer

- [x] **`computeHashDual`** — pure helper в `hashProviders.ts`: возвращает `{ sha256: string; blake3: string }`. При отсутствии BLAKE3 backend'а fallback к sha256 в обоих полях.
- [x] **`pushFile` writes both** — `hashCanonicalBufferDual` подключён в `syncEngine.pushFile` через новый `SyncEngineDeps.canonicalHashAlgo: () => "sha256" | "blake3" | "dual"` getter; `_engineFactory.ts` читает setting `vscodesync.canonicalHashAlgo`. При `algo !== "sha256"` в `MetaEntry` пишется `hashBlake3`. SHA-256 канал не меняется (legacy compat).

### v2.3.3. Reader compatibility

- [x] **`compareMetaHash` extended** — pure helper в `hashProviders.ts`: если manifest имеет `hashBlake3` и preferred=`blake3` → сравнивает blake3, иначе fallback на sha256 (всегда есть). 5 unit-тестов.
- [x] **Migration check at startup** — `runHashAlgoMigrationCheck` в `src/core/hashMigrationCheck.ts`: pure helper над списком workspaces+entries, возвращает per-workspace ratio + global `safeToSwitchToBlake3`. 5 unit-тестов.

### v2.3.4. Transition window

- [x] **Команда `vscodesync.checkBlake3Migration`** — `src/commands/registerHashMigration.ts`. Walks `_meta.json` всех active workspaces через `provider.downloadFile(metaCloudPath(workspaceId))`, агрегирует через `runHashAlgoMigrationCheck`, выдаёт rec через `planBlake3MigrationAction` (с `dualWorkflowStartedMs` из `globalState['vscodesync.canonicalHashAlgo.dualWorkflowStartedMs']` — re-stamped при flip на `dual`, очищается при flip обратно). Output channel: per-workspace ratio + global recommendation + setting-aware hint.
- [x] **Команда `vscodesync.completeBlake3Migration`** — `src/commands/registerHashMigration.ts:registerHashMigrationCommands` принимает `makeEngineForRoot(root, provider)` callback и вызывает `engine.applyHashBlake3Backfill(workspaceId, tasks)` через `planBlake3MigrationTasks`. Wiring в `extension.ts` line 620 (`makeEngineForRoot` factory). Output channel: applied/drift/missing/already counters per workspace + cancellable progress.

### v2.3.5. Performance + telemetry

- [x] `docs/v2/blake3-benchmark.md` + `scripts/benchmarks/blake3-bench.mjs`. Markdown-friendly bench script (4 workspace sizes 10×5KB, 100×50KB, 100×500KB, 10×5MB), warm-up + perf_hooks timing, sample numbers + when-to-switch guidance + dual-hash workflow.
- [x] Activity log: `kind: "hash_migration"` зарегистрирован в `ActivityKind` union.

---

## v2.4. ~~Cloudflare / Tailscale tunnel~~ — DROPPED (2026-05-09)

Удалено: позиционирование «indie tool», smee.io признан достаточным.
См. `docs/v2/roadmap.md` → Anti-recommendations.

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

- [x] **`src/commands/registerSmartFeatures.ts`** — bundle с контрактом `{ context, storageDir }`: `showAchievements` + `installWorkspaceTemplate`. `bulkPush` теперь в `registerSyncOps.ts` (commit `e7a5787`).
- [x] **`src/commands/registerSmartFeaturesEngine.ts`** — engine-rich bundle с контрактом `{ context, globalConfig, tryAuthenticatedProvider }`: `aiSessionSummary`, `aiSuggestWorkspaceTags`, `aiPathMapper`, `showInsightsWeeklyDigest`, `diffSnapshots`. Helper `ensureAiCommandEnabled` co-located. `openTimeTravelScrubber` остаётся в `registerFileOperations.ts` (file-ops группа).

### v2.6.7. Validation

- [x] **CI regression check:** `tests/unit/packageJsonCommandsConsistency.test.ts` — assert каждый `contributes.commands[].command` присутствует в `WEB_STUB_COMMAND_IDS` + no-duplicates check. Если refactor забывает зарегистрировать команду в одном из мест — тест падает.
- [~] **`extension.ts < 500 LoC` assert** — текущий **1734 LoC** (стартовый 5085 = -66%). Прогресс по подъёму closures + helpers в shared modules:
  - `_providerFactory.ts` — `ensureProvider` + `tryAuthenticatedProvider` (49 LoC)
  - `_fileTargetHelpers.ts` — `resolveFileTarget` + `resolveFileTargetLoose` (~60 LoC)
  - `_engineFlows.ts` — `runShowFileHistory` + `runConflict3WayDiff` + `runAiMergeForConflict` + `openTrackedFileInCloudStorage` + internal `historyVersionLabel` (~310 LoC)
  - `auth/providerAuthFlows.ts` — `createProviderAuthFlows(deps)` factory packs 4 OAuth closures + 4 OutputChannels (~205 LoC)
  - Plus `runAddToNewWorkspace` (135 LoC) перенесён в `registerFileOperations.ts` как private impl.
  Bundles теперь импортируют helpers напрямую — отпали 6 callback-deps wrappers в extension.ts.

  Оставшийся ~1700 LoC: `makeEngine` factory (~218 LoC, 6 module-level mutable Sets для dedup warnings + 5 ref-сettable callbacks для activity/transfer/compression/tree-refresh/repush), `runWithEngine` closure (~50 LoC), startup-wiring (config load / registry init / watchers / event handlers / `registerXxx` calls для panels/timers/health/heartbeat / soft-lock lifecycle), `updateWorkspacesTreeBadge` + helper closures. Дальнейшее снижение требует:
  1. `_engineFactory.ts` с `createMakeEngine(deps)` — overhead ~280 LoC moves out, но требует осознанного решения по shared state ownership (warnedXxx Sets либо module-private к `_engineFactory.ts`, либо проброс через deps).
  2. `_runWithEngine.ts` с `createRunWithEngine(deps)` — отдельный compose поверх `_engineFactory.ts`.
  3. Декомпозиция startup-wiring в `src/startup/` с темами (lifecycle / watchers / panels / timers).

---

## v2.9. Smart Conflict Prediction — full presence wire

**Текущее состояние:** UI сервис (`SmartConflictPredictionService`) показывает status-bar
warning над soft-lock signal. Это **post-fact** — pred. событий уже произошло.

### v2.9.1. _machines.json schema extension

- [x] **Расширил `MachineEntry`:** optional `currentEditing: { workspaceId, relPath, sinceMs } | null` в `cloudLayout.ts`. Forward-compat — старые readers игнорируют поле.
- [x] Schema validator в `manifestValidate.ts` accepts both shapes — `undefined` / `null` / валидный объект, отвергает мусор.

### v2.9.2. Heartbeat propagation

- [x] Pure helpers в `src/core/presenceCurrentEditing.ts`: `buildCurrentEditingFrame({ workspaceId, relPath, nowMs, mode })`, `shouldBroadcastCurrentEditing({ last, next, nowMs, throttleMs? })` (throttle 30 s по-умолчанию). Wired в `presenceHeartbeat.ts`: каждый tick резолвит `activeTextEditor` → `WorkspaceConfigManager.load(folder)` → tracked file → `buildCurrentEditingFrame` (mode из setting `smartConflictPrediction.broadcastCurrentEditing`). Throttle через mutable `lastBroadcastFrame` + `shouldBroadcastCurrentEditing`. `parseMachinesRegistry` / `upsertMachineAndPrune` / `syncMachinesRegistrySelf` расширены опциональным `currentEditing` (forward-compat).

### v2.9.3. Reader

- [x] `scorePresenceRisk({ myWorkspaceId, myRelPath, myAnonymised?, peerCurrentEditing })` — pure scorer, returns 0..1. Wired в `SmartConflictPredictionService`: optional `tryAuthenticatedProvider` constructor parameter; presence reader poll-ит `_machines.json` каждые 60 с, парсит `currentEditing` peer'ов в `PresenceCache` (TTL 60 s); `findHighRiskPeer` augment'ит soft-lock score'ом `live presence`. Status-bar tooltip отмечает источник риска (soft-lock / live presence / both).

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
- [x] **412 PreconditionFailed** edge-cases — pure renewTick decision `src/core/webhookLifecycleRenewTickDecision.ts:decideWebhookRenewTick` подключён в OneDrive + GoogleDrive renewTick. Strict envelope decoders в `graphWebhookSubscription.ts` + `gdrivePushChannelApi.ts`. Mock matrix `tests/unit/webhookReconcileEdgeCases.test.ts` (8 тестов) пинит decisions для smee reconnect URL drift / webhooks disabled / no_token race / no_notification_url / not_yet_due / within-renew-window / provider_mismatch / missing state — фиксирует контракт перед follow-up рефакторингом `reconcileBody` на adapter pattern.

### v2.10.2. Auto-renewal

- [x] Pure planner `src/core/webhookAutoRenewal.ts` — `planWebhookRenewal(subscriptions, now?, slackMs?)` возвращает `actions[]` (`renew_now` / `expired_recreate` / `wait_until` с `nextDueMs`) + `nextWakeMs` (раннее время для `setTimeout`). Использует существующий `isNearOrPastExpiration` (slack 20 мин). 6 unit-тестов.
- [x] Pure loop driver `src/core/webhookRenewalLoop.ts` подключён в `oneDriveWebhookLifecycle.ts`: вместо fixed `setInterval(4 min)` теперь adaptive scheduling через `planWebhookRenewal`. `fetchSubscriptions` гардит `decideWebhookRenewTick` (skip-on-disabled / no-token / not-yet-due возвращают пустой список — driver спит до nextWakeMs); `onRenew` вызывает `graphRenewSubscription`; `onRecreate` тригерит `refresh()` (existing reconcile branch). Logs идут в существующий OutputChannel.

---

---

## v2.11. Foundation wiring — extension.ts decomposition (Phase 0)

**Текущее состояние (2026-05-09):** SHIPPED in commit `6a5e827`. extension.ts
ушёл с 1734 → 806 LoC (-54%). 8 startup modules под `src/startup/`.
1604/1604 unit tests pass.

### v2.11.1. Engine factory extraction

- [x] **`src/startup/_engineFactory.ts`** — `createEngineFactory(): EngineFactory` (`makeEngine`, `setRefs`, `notifiedConflictKeys`). Переносит весь `makeEngine` (213 LoC), 6 dedup Set'ов и 5 ref-callbacks.
- [x] Тесты: `tests/unit/engineFactory.test.ts` — contract surface + isolation (6 тестов: notifiedConflictKeys is mutable Set, isolation between instances, setRefs accepts partials, idempotent re-assign).

### v2.11.2. runWithEngine extraction

- [x] **`src/startup/_runWithEngine.ts`** — `createRunWithEngine(deps): RunWithEngineFn`. Сигнатура `RunWithEngineFn` остаётся exported из `commands/registerWorkspaceLifecycle.ts` для совместимости с существующими bundle imports.

### v2.11.3. Startup helpers split

- [x] **`src/startup/registerWebhookLifecycles.ts`** — wraps OneDrive + GoogleDrive lifecycles + общий `webhooksOut` channel + общий `webhookSyncDeps`. Возвращает `{ refresh, webhookSyncDeps }`.
- [x] **`src/startup/registerCodeLensProviders.ts`** — last-sync + inline-conflict + hot-zone CodeLens + hover-diff (4 providers).
- [x] **`src/startup/registerScheduledHelpers.ts`** — startup summary + long-absence + token-expiry + workspace-inactive-archive prompt + smart-workspace-suggestions + machine-approval-notifier (вместе с `VSCodeSync · Startup` OutputChannel).
- [x] **`src/startup/registerFileLifecycleEvents.ts`** — file deletions / renames + soft-lock lifecycle (60 min auto-clear).
- [x] **`src/startup/registerOnboardingFlow.ts`** — onboarding wizard + machines self-sync + URI handler + gitignore self + health auto check + Timeline provider.
- [x] **`src/startup/registerWorkspaceTreeWiring.ts`** — workspaces tree DnD + setFetchRemoteSummaries + treeView creation + filter chrome + badge update subscription.

### v2.11.4. extension.ts target

- [x] **`extension.ts → 806 LoC`** (target was ≤ 700; -54% achieved, additional -106 LoC requires extracting `runAfterSessionResume` closure (~75 LoC) and provider migration block (~45 LoC) — separate pass).
- [x] CI assert: `tests/unit/extensionTsLoc.test.ts` enforces `LOC_CEILING = 820` (current ~812 после удаления tunnel imports). Soft target 500. Понижается каждый раз когда новая extraction.

---

## v2.12. P2P UI wiring — visible Phase 1.A

**Текущее состояние (2026-05-09):** scaffolding shipped (commit `55ae99b`).
Pure-helpers полностью готовы; команда + status bar + registry поверх них
работают, но реальный signaling round-trip + DataChannel + qrcode-terminal
рендер запрятаны за `vscodesync.p2p.experimental` setting (off by default)
и пока возвращают информационное сообщение. Полная реализация — следующая
итерация.

### v2.12.1. Session command

- [x] **`src/commands/registerP2PSession.ts`** — `vscodesync.startP2PSession` + `vscodesync.disconnectP2PSession` (scaffolding).
- [x] Multi-step QuickPick из `planP2PSessionWizard(...)`. Шаги отображаются с описанием каждой фазы и transport (cloud / qr).
- [x] Cloud transport — wired в `runStartP2PSession` (registerP2PSession.ts:135) через `createSignalingTransport` + `openP2PSession`; gated behind `vscodesync.p2p.experimental`. Real `@roamhq/wrtc` DataChannel + crypto envelope активны при включённой настройке.
- [~] QR transport — `src/core/p2pQrTerminalRenderer.ts` (`renderQrToLines` + `renderChunkBlock`) lazy-load'ит `qrcode-terminal` (optional dep), 6 unit-тестов на module_not_installed / module_load_failed / shape rejection / chunk header. UI-обвязка (`OutputChannel.appendLine` + `InputBox` для scanned answer) — следующая итерация.
- [x] Aborts при `no_online_peers` / `no_active_invites` warnings — отображаются в QuickPick как `$(warning)` items.

### v2.12.2. Status bar

- [x] **`src/ui/p2pStatusBar.ts`** — `createP2PStatusBarItem(context, registry)` поверх `formatP2PStatusBar(registry.primary().snapshot)`. Click → `vscodesync.disconnectP2PSession`. `registry.subscribe()` driven re-render — без `setInterval`.

### v2.12.3. Idle tick runner

- [x] Idle tick runner inline в `p2pSessionRuntime.openP2PSession`: после установки channel создаётся `createP2PIdleTracker` + `setInterval` на 30 s; `noteFrame` triggered на каждом authenticated frame через `authChannel.onFrame` subscription. На `disconnect` decision: `machine.end("idle_timeout")` + `authChannel.close()`. Cleared в `close()`.

### v2.12.4. Session runtime + file-transfer hook

- [x] **`src/core/p2pSessionRegistry.ts`** — pure in-memory registry с notify-on-mutation (commit `55ae99b`).
- [x] **`src/ui/p2pSessionRuntime.ts`** — `openP2PSession` glues state machine / signaling transport / wrapAuthenticated channel (run 23, commit `1991d81`).
- [x] **`syncEngine.pushFile`** хук: `SyncEngineDeps.onPushFile?: (workspaceId, posixRel, plaintext, meta)` callback (run 22, commit `ffebda1`).
- [x] **File-transfer mirror** — `src/ui/p2pFileTransferMirror.ts:mirrorPushedFile` + `createMirrorRegistry`. `_engineFactory.ts` вызывает mirror через `refs.mirrorPushedFile`. `runStartP2PSession` биндит authenticated channel в registry; disconnect — `unbind`. На каждый `pushFile`: `planP2PFileChunks` → `manifest` frame → N × `file_chunk` frames через `wrapAuthenticated.sendFrame`. Best-effort, errors swallowed. _Receiver путь (chunk assembly + write to disk) остаётся следующей итерацией._
- [x] Heartbeat tick — covered by idle tick runner (v2.12.3); `noteFrame` triggered by `authChannel.onFrame` subscription so any inbound frame counts as liveness signal.

### v2.12.5. Activity log integration

- [x] `OpenP2PSessionOptions.onSessionEvent?` callback fan-out'ит каждый `state.machine.events[]` к caller'у (cursor-based drain + 30 s tick). `registerP2PSession.runStartP2PSession` форвардит в `logSyncActivity` как `kind: "p2p_session"` (новый ActivityKind, forward-compat).

---

## v2.13. ~~Tunnel wiring~~ — DROPPED (2026-05-09)

Удалено вместе с v2.4. `oneDriveWebhookLifecycle.ts` откачен на прямой
`createAndStartSmeeRelay`. Все pure helpers (URL scrape / spawn watchdog /
ACL parser / status registry / config watcher) и backends удалены.

---

## v2.14. Smart Features wiring — Phase 1.C

**Текущее состояние (2026-05-09):** все 6 команд **уже зарегистрированы и
функциональны** — в `src/ui/plannedPaletteCommands.ts` (5 шт.) и
`src/commands/registerFileOperations.ts` (`openTimeTravelScrubber`). Деление
на `registerSmartFeaturesEngine.ts` с фокусным контрактом — чистый
архитектурный refactor (без user-visible изменений), запланирован отдельно.

### v2.14.1. Engine bundle (refactor, no behaviour change)

- [x] `vscodesync.aiSessionSummary` — moved to `registerSmartFeaturesEngine.ts`.
- [x] `vscodesync.aiSuggestWorkspaceTags` — moved to `registerSmartFeaturesEngine.ts`.
- [x] `vscodesync.aiPathMapper` — moved to `registerSmartFeaturesEngine.ts` (delegates to `aiPathMapperCommand.ts`).
- [x] `vscodesync.showInsightsWeeklyDigest` — moved to `registerSmartFeaturesEngine.ts`.
- [x] `vscodesync.diffSnapshots` — moved to `registerSmartFeaturesEngine.ts`.
- [x] `vscodesync.openTimeTravelScrubber` — registered in `registerFileOperations.ts:471` (file-ops группа).
- [x] _Refactor:_ 5 commands вынесены из `plannedPaletteCommands.ts` в `src/commands/registerSmartFeaturesEngine.ts` с фокусным `{ context, globalConfig, tryAuthenticatedProvider }` контрактом.

### v2.14.2. AI cancellation + privacy

- [x] Все AI-команды (sessionSummary / suggestWorkspaceTags / pathMapper) используют `vscode.CancellationToken` — `withProgress({ cancellable: true })` в `plannedPaletteCommands.ts`, token прокинут в helper-сигнатуры (`summariseActivity` / `suggestWorkspaceTags` / `runAiPathMapper`). Internal `CancellationTokenSource` остаётся как fallback при отсутствии external token (back-compat).
- [x] Per-command privacy gate: settings `vscodesync.ai.sessionSummary.enabled` / `vscodesync.ai.suggestWorkspaceTags.enabled` / `vscodesync.ai.pathMapper.enabled`. Default — `false`. Helper `ensureAiCommandEnabled(key, title)` показывает toast «отключена в целях приватности; включите в Settings» с действием `"Open Settings"`. `aiMerge` уже имеет существующий setting `vscodesync.aiMerge: boolean` (не дублируем).

---

## v2.20. Fresh ideas (brainstorm — записаны, не запланированы)

> Brainstorm-список из 16 идей, добавленных по запросу пользователя. Каждый пункт — потенциальный
> отдельный roadmap-item; реализация только после явного pick'а конкретной идеи.

### v2.20.1. Архитектурные / DX (1–3)

- [x] **MCP server endpoint** — `@modelcontextprotocol/sdk` installed; `src/ui/mcpServerHost.ts:startMcpServer(provider)` lazy-loads SDK, регистрирует `vscodesync.list_workspaces` tool с реальным data source. Other tools throw `McpNotImplementedError` (engine adapter — follow-up). Stdio bridge через npm bin — отдельная итерация.
- [x] **CLI `vscodesync`** — `cli/` subpackage уже имеет `bin/vscodesync` (`./dist/cli.cjs`), entry `cli/src/main.ts` с дispatch-table (`status` / `pull` / `pull-all` / `auth --device-code`). Sub-package builds via esbuild → standalone CommonJS. Pure `parseCliArgs(argv)` в `src/core/cliArgsParser.ts` остаётся как тестируемая часть.
- [x] **Settings Sync integration** — pure split planner `src/core/settingsSyncIntegration.ts` (`SETTINGS_SYNC_RULES` + `splitSettingsForSync` + `SettingsSyncNotImplementedError`); 7 unit-тестов. Defensive live probe `src/ui/settingsSyncProbe.ts:probeSettingsSyncSession` оборачивает `vscode.authentication.getSession("vscode-settings-sync", scopes)` в discriminated result (`provider_missing` / `user_rejected` / `unknown_error` / available); 7 unit-тестов на каждый rejection branch + happy path.

### v2.20.2. Performance / scale (4–6)

- [~] **WebRTC SCTP multiplexing** — pure planner `src/core/p2pSctpMultiplex.ts` (6 тестов). Runtime adapter `src/core/sctpRuntimeHook.ts:SctpRuntimeAdapter` typed surface + `makeSkeletonSctpRuntime` + `SctpRuntimeNotImplementedError`; 2 теста. Multi-DataChannel wiring (одна `RTCPeerConnection` с N stable channels) остаётся.
- [~] **DuckDB-WASM для analytics** — `@duckdb/duckdb-wasm@1.33` installed; `src/ui/duckdbAnalyticsHost.ts:loadDuckDb` lazy-loads bundle. Mount planner `src/core/duckdbVirtualTables.ts:planVirtualTableMount` эмитит `INSTALL json; LOAD json;` + `CREATE OR REPLACE VIEW <table> AS read_json_auto(...)` per source; SQL identifier validation + `DuckDbHostNotAvailableError`; 4 теста. Worker host остаётся (нужен webview-side bundle).
- [~] **Sync prefetch hints** через `workspace.fs.prefetch(uri)` — pure planner `src/core/workspaceFsPrefetchHints.ts` (7 тестов). Defensive adapter `src/ui/workspaceFsPrefetchAdapter.ts:tryPrefetchUris` пробит на `surface.fs.prefetch` runtime check + discriminated result (`api_not_available` / `no_uris` / `error`); 4 теста. Команда `vscodesync.prefetchActiveWorkspace` wiring остаётся.

### v2.20.3. Security / privacy (7–9)

- [x] **Encrypted bundle export** — `vscodesync.exportEncryptedBundle` shipped (commit `c3332db`). `.vscsbundle` format = magic + AES-256-GCM via `exportKeyWithPassword`; ≥12-char passphrase enforced.
- [x] **OAuth Device Code flow** — pure RFC 8628 helpers `src/core/oauthDeviceCodeFlow.ts` (commit `c3332db`); UI command `vscodesync.signInDeviceCode` shipped в `src/commands/registerOAuthDeviceCode.ts`; per-provider endpoints в `src/startup/resolveDeviceCodeProviders.ts` (OneDrive `login.microsoftonline.com/common/oauth2/v2.0` + Google Drive `oauth2.googleapis.com/device/code`, gated на `googleDriveClientId` setting).
- [x] **Local LLM для AI merge** — `src/core/aiMerge.runAiMerge:84-95` диспатчит через `resolveAiMergeEndpoint`: `vscode-lm` → `callVscodeLm`, иначе → `callHttpEndpoint` (Ollama / OpenAI-chat / lm-studio body shapes). `isAiMergeAvailable` гард: для не-vscode-lm endpoints возвращает true (reachability check at call-time).

### v2.20.4. Modern protocols (10–12)

- [~] **Webhook → SSE upgrade для GDrive / OneDrive** — pure SSE декодер `src/core/webhookSseDecoder.ts` (10 тестов). Per-provider config registry `src/core/sseProviderRegistry.ts:SSE_PROVIDER_REGISTRY` (4 провайдера, все `available: false` с unavailableReason); `SseProviderUnavailableError` sentinel; 4 теста. Real per-provider connection (Drive Activity API streaming) остаётся.
- [~] **OAuth 2.1 PAR (Pushed Authorization Requests)** — pure planner `src/core/oauthPushedAuthRequest.ts` (10 тестов). Per-provider config `src/core/parProviderRegistry.ts:PAR_PROVIDER_REGISTRY` (4 провайдера, все `parEndpointUrl: null` — никто из консьюмерских OAuth endpoints не объявил PAR в OIDC discovery); `extendParParamsForProvider` помощник; 4 теста. PAR-aware sign-in flow остаётся (включится автоматически когда провайдер объявит endpoint).
- [~] **WebAuthn → Passkeys (FIDO2 with sync)** — pure reconciler `src/core/passkeyMultiDeviceReconciler.ts:reconcilePasskeyRegistries` (6 тестов). Wire-format transport `src/core/passkeyPeerRegistryTransport.ts` (`encodePeerRegistryFrame` / `decodePeerRegistryFrame` strict-decoder с reasons `bad_envelope` / `bad_version` / `bad_payload` + `PasskeyTransportNotEnabledError` для p2p и cloud_mirror транспортов); 5 тестов. Wire-up в `openP2PSession` / cloud-mirror flow остаётся под opt-in setting.

### v2.20.5. UX / fit-and-finish (13–16)

- [x] **`.vscodesync-readme.md` auto-render** — `vscodesync.showWorkspaceReadme` + first-open auto-render in `src/commands/registerReadmeAutoRender.ts`; pure markdown renderer in `src/core/workspaceReadmeMd.ts` (XSS-safe; subset: headings / lists / inline bold-italic-code / safe http(s) links). 6 unit tests. Commit `c3332db`.
- [x] **Conflict heatmap → SARIF export** — `vscodesync.exportConflictsToSarif` shipped (commit `c3332db`). SARIF v2.1.0 builder in `src/core/conflictHeatmapSarif.ts` with %SRCROOT% uriBaseId, dedup, line-range clamping. 7 unit tests.
- [x] **Workspace templates marketplace** — typed `WorkspaceTemplateManifest` + strict `parseWorkspaceTemplate` в `src/core/workspaceTemplate.ts` (commit `c45337d`). Команда `vscodesync.installWorkspaceTemplateFromMarketplace` в `src/commands/registerTemplateMarketplace.ts`: fetch raw GitHub index → concurrent fetch+parse каждого manifest → QuickPick → `applyTemplate` (provenance file `.vscodesync-template.json` + merge ignore patterns + welcome webview + extension install prompt). Default registry — `borodatych/vscodesync-templates`, перекрывается setting `vscodesync.templates.registryUrl`.
- [~] **Onboarding video walkthroughs** — pure spec `src/core/walkthroughVideoSpec.ts` (`ONBOARDING_VIDEO_SPECS`, `buildWalkthroughVideoStep`, `renderVideoMarkdownBody`); 6 unit-тестов. `package.json contributes.walkthroughs` расширен 3 шагами с `media.markdown` ссылками; `media/walkthroughs/*.md` checked-in, `*.mp4` в `.gitignore` до реальной записи. **Blocked:** реальные MP4 captures (нужен человек с экраном).

---

## Состояние

Когда **все** чекбоксы выше закроются — v2 будет fully shipped. Текущее: 0/100+ закрыто
(всё в скелетах / DONE-частях, перечисленных в основном [v2/roadmap.md](roadmap.md)).
