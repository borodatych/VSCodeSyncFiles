# Quick Transfer — разовая передача

> Отправить файл на другую машину без постоянного трекинга.

**Часть фазы:** [06-power-features](roadmap.md)  
**Реализация:** `src/core/quickTransfer.ts`, `src/ui/quickTransferUi.ts`

---

## Flow

1. ПКМ → **Send to Other Machine (one-time)** → quick-pick целевой машины из `_machines.json`
2. На другой машине при старте/фокусе — уведомление: `Получить | Ответить | Игнорировать`
3. `[Получить]`: скачать → записать → `receivedAt` → удалить с облака
4. `[Ответить]`: открыть `Send to Other Machine` с предзаполненным `targetMachineId` = отправитель
5. Файл **не добавляется** в трекинг

---

## Реализация

- [x] Команда `VSCodeSync: Send File (One-time Transfer)` + ПКМ Explorer / редактор
- [x] Quick-pick `"Кому?"` → список машин из `_machines.json` через `readMachinesRegistrySafe`; опция «Все машины»
- [x] `targetMachineId` передаётся в `sendQuickTransferFile`; получение только на целевой машине (`listIncomingQuickTransfers` фильтр)
- [x] Кнопка «Ответить» в notification → предзаполняет `_replyToMachineId`
- [x] При фокусе окна и по таймеру (~2 мин): проверка `_quicktransfer/`, диалог `Получить / Ответить / Игнорировать`
- [x] 404 race condition: если файл уже получен другой машиной — graceful info message

---

## TTL

- [x] `vscodesync.quickTransferTtlDays: 7` (умолч)
- [x] При отправке: сообщение «доступен до {date}»
- [x] Истёкшие пакеты удаляются с облака при опросе
- [x] В оффлайн-очереди: TTL проверяется перед flush

---

## Pause / Quick Transfer

- [x] Глобальный Pause **не блокирует** Quick Transfer
- [x] Suspend/Freeze workspace **не блокирует** Quick Transfer
- [x] Offline: в оффлайн-очередь (`enqueueQuickTransferSend`)
