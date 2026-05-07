# Watch Mode

> Опциональный режим автоматического polling облака. Для сценариев когда обе машины активны одновременно.

**Часть фазы:** [06-power-features](roadmap.md)  
**Реализация:** `src/ui/watchModePoller.ts`

---

## Включение

- [x] Команды `VSCodeSync: Enable Watch Mode` / `VSCodeSync: Disable Watch Mode` / `VSCodeSync: Toggle Watch Mode`
- [x] Настройки: `watchMode`, `watchIntervalSeconds` (30), `watchMaxIntervalSeconds` (300), `watchAdaptive` (true)
- [x] Статус-бар: `👁 Watch` индикатор (`SyncStatusBarController`)
- [x] Автоматически останавливается при закрытии VSCode (subscription cleanup в `registerWatchModePoller`)

---

## Polling логика

- [x] Каждые N секунд: `runQuietFullSyncAllFolders` → `syncWorkspace` для каждого активного workspace
- [x] Pull только если что-то изменилось (manifest ETag check через `If-None-Match` в `downloadManifest`)
- [x] При конфликте: `onNewConflict` уведомление (один раз на конфликт), Watch Mode не останавливается

---

## Группировка уведомлений

- [x] Если за один цикл обновилось несколько файлов → одно уведомление через Notification Digest (`recordDigestPush`/`Pull` в `logSyncActivityRef` → `flushDigest` каждые `digestIntervalMinutes`)

---

## Адаптивный интервал

- [x] После 5 consecutive тиков → удвоить интервал (до `watchMaxIntervalSeconds`)
- [x] При обнаружении изменения → сбросить к `watchIntervalSeconds` (`runQuietFullSyncAllFolders` возвращает `boolean`; при `changed=true` → `idleCycles=0` + `applyInterval(baseMs())`)
- [x] `vscodesync.watchAdaptive: false` — отключить адаптивность

---

## Watch Mode + Pause / Rate Limit / Schedule / AutoPause / Webhooks

- [x] При глобальном `syncSessionPause.isPaused()` → tick пропускается
- [x] При `syncAutoPause.isActive()` → tick пропускается
- [x] При `isAutoSyncBlockedBySchedule()` → tick пропускается
- [x] При `isAutoSyncBlockedByRateLimit()` → tick пропускается
- [x] При включённых webhooks + активной подписке → tick пропускается; при «тишине» дольше `fallbackAfterMinutes` → возобновляется с уведомлением

---

## Soft Lock + Watch Mode

- [x] При активном `editingBy !== currentMachineId`: Watch Mode пропускает Pull — реализовано в `syncWorkspace` (проверка `m.editingBy && m.editingBy !== machineId → continue`)

---

## Diff в уведомлении (inline preview)

- [x] При обновлении файла < 20 строк diff → краткий diff в уведомлении (только при `notificationLevel: verbose`; `makeOnFilePulledCallback` + `buildInlineDiff` в `extension.ts`; `onFilePulled` callback в `SyncEngineDeps`)
