# Фаза 17: Finish underbaked features (v0.11)

> **Цель:** довести до 100% фичи, которые в `docs/v2/roadmap.md` стоят как partial / skeleton. Каждая — отдельная подфаза, может быть запущена независимо.

**Зависимости:** v0.10 (UX)
**Следующая фаза:** [18-provider-parity](../18-provider-parity/roadmap.md)
**Перекрёстная ссылка:** см. также [v2/roadmap.md](../../v2/roadmap.md) — там описана стратегическая ценность каждой фичи; здесь — конкретные шаги завершения.

---

## 17.1 WebRTC P2P signaling round-trip (F-030)

Скелет (envelope + DataChannel + crypto frame) уже готов на ~60%. Закрываем разрыв.

- [ ] **smee.io relay path:**
  - [ ] Использовать существующий `webhookTunnel` для двусторонней отправки signaling envelope
  - [ ] Один peer публикует offer на smee endpoint → другой peer poll-ит → отправляет answer обратно
  - [ ] Strict envelope encoder/decoder уже в `p2pSignaling.ts` — wire only
- [ ] **QR offer/answer path** (air-gapped, без smee):
  - [ ] Команда `vscodesync.startP2PSessionByQR` — генерирует QR с offer, показывает в webview (deferred)
  - [ ] Команда `vscodesync.joinP2PSessionByQR` — webview с camera capture или ручной ввод (deferred)
  - [x] Pure encoder/decoder `encodeQrSdpEnvelope / decodeQrSdpEnvelope` — gzip+base64url+header, target < 1KB
  - [x] `isQrFriendlySize` helper для UI warning
  - [x] Unit-тесты на round-trip + malformed inputs (`tests/unit/p2pQrSdpCompact.test.ts`)
- [ ] **Палитра команд:**
  - [ ] `vscodesync.startP2PSession` (выбор machine + transport: smee | QR)
  - [ ] `vscodesync.stopP2PSession`
  - [ ] `vscodesync.showP2PSessions`
- [ ] **Engine integration:**
  - [ ] `onPushFile` уже зарегистрирован в `mirrorPushedFile` — нужен обратный путь `onP2PFileReceived` (manifest update + write to disk)
  - [ ] `p2pFileTransferReceiver.workspaceId = null` (hard-coded) → передавать через manifest envelope
- [ ] **Acceptance:**
  - Два VS Code на одной машине, один смотрит на cloud=mock, другой — на тот же mock. После `startP2PSession` любой save в окне A появляется в окне B без cloud touch (verified в Activity Feed).
  - Integration test через `tests/integration/p2p-smoke.ts` (skeleton уже есть в `docs/v2/p2p-smoke-guide.md`)

## 17.2 Passkey recovery codes UI (F-031)

Backend (`passkeyRecoveryCodes.ts`) и envelope уже есть на ~70%. Нужна UI.

- [ ] Webview `passkeyRecoveryCodesPanel.ts`:
  - [ ] Generate: показать 10 кодов формата `XXXX-XXXX-XXXX` (uppercase A-Z 0-9, без I/O/0/1)
  - [ ] Download as `.txt` / Copy all / Print
  - [ ] Verify: input field, проверяет валидность без consume
  - [ ] Used count display
- [ ] Команды:
  - [ ] `vscodesync.generateRecoveryCodes` (требует unlock)
  - [ ] `vscodesync.useRecoveryCode` — fallback flow при потере passkey, consume код, unwrap DEK
- [ ] Acceptance: enroll passkey → generate codes → удалить passkey из системы → recovery code разблокирует доступ
- [ ] Snapshot test HTML
- [ ] Тест на planPasskeyRecoveryFlow с lockout

## 17.3 WASM zstd + BLAKE3 на write-path (F-032)

Сейчас `canonicalHashAlgo` setting только для read/dual; нужно полное применение для write.

- [ ] При `canonicalHashAlgo = "blake3"`:
  - [ ] `pushFile` пишет blake3 hash в `_meta.files[].hashBlake3` И в `hash` (для совместимости с старыми readers ставит SHA-256)
  - [ ] При `dual`: оба поля. При `sha256`: только sha256 (текущее).
- [ ] `wireZstd` codec:
  - [ ] Setting `vscodesync.compressUploads.algo`: `gzip | zstd | none` (default `gzip`)
  - [ ] При `zstd`: `compressUploads` пайплайн использует `zstd` из `platformCompression` (уже подключён optional dep `@bokuweb/zstd-wasm`)
  - [ ] `_meta.wireZstd = true` устанавливается; readers tolerate unknown codec (через `chooseWireCodec`)
- [ ] Migration plan:
  - [ ] Команда `vscodesync.migrateHashToBlake3` — proceed if all machines in `_machines.json` advertise blake3 capability
  - [ ] Hash migration uses existing `hashMigrationCheck`
- [ ] Bench: targets 5–15× ускорение vs SHA-256/gzip на больших текстовых файлах. См. `docs/v2/blake3-benchmark.md`.

## 17.4 AI Bulk Review on push (F-033)

`bulkPushAiReviewFlow.ts` существует как pure helper; не вызывается из обычного push.

- [ ] Setting `vscodesync.ai.bulkReviewOnPush` (default `false`)
- [ ] При включении: в `pushAll` после mass-change-guard добавить `runBulkReview` для пакетов >5 файлов
- [ ] Review генерирует summary через Copilot LM («Эти X файлов: добавляют feature Y, рефакторят Z, исправляют W»)
- [ ] Confirmation modal: «Push 12 файлов? AI summary: ...» + кнопка «Show details»
- [ ] Skip-button «Push без AI review» (сохраняется как пользовательская преференция per workspace)
- [ ] Pure prompt + parser unit-тесты

## 17.5 Sync Replay — jump to file as-of (F-034)

`syncReplayViewer` отображает события; клик → ничего.

- [ ] В viewer добавить кнопку «Open file at this point» для events kind=`push` / `pull`
- [ ] Использует существующий `.history/` для восстановления нужной версии
- [ ] Если версия пропала (history rotation) — показать info «История ротировалась, версия больше недоступна»
- [ ] Открыть в diff editor: текущая vs as-of
- [ ] Acceptance: при просмотре события «push file.ts 2 часа назад» клик открывает diff локального файла vs blob из .history
