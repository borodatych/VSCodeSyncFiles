# Фаза 5: Providers

> **Цель:** добавить Google Drive, Яндекс Диск и Dropbox. После этой фазы: расширение работает с 4 провайдерами и умеет мигрировать между ними.

**Зависимости:** [04-reliability](../04-reliability/roadmap.md) ✅  
**Следующая фаза:** [06-power-features](../06-power-features/roadmap.md)

---

## Провайдеры

| Провайдер | Файл | Статус |
|-----------|------|--------|
| OneDrive | [onedrive.md](onedrive.md) | `[x]` (фаза 2) |
| Google Drive | [gdrive.md](gdrive.md) | `[~]` — OAuth device flow + Drive API v3 (`src/providers/gdrive/`), настройка `vscodesync.googleDriveClientId` |
| Яндекс Диск | [yandex-disk.md](yandex-disk.md) | `[x]` — OAuth PKCE loopback + Disk API (`src/providers/yandex/`), `vscodesync.yandexOAuthClientId`, redirect `http://127.0.0.1:8735/oauth-callback` |
| Dropbox | [dropbox.md](dropbox.md) | `[~]` — OAuth PKCE loopback (`src/providers/dropbox/`), `vscodesync.dropboxAppKey`, redirect `http://127.0.0.1:8734/oauth-callback` |

---

## 5.1 Переключение активного провайдера (`VSCodeSync: Switch Provider`)

- [x] Quick-pick провайдеров (авторизованные / неавторизованные в описании; OneDrive — вход перед переключением) — `src/ui/activeProviderSwitch.ts`, команда `vscodesync.setActiveProvider`
- [x] При переключении на провайдер с workspace'ами от другого — модальное предупреждение и «Migrate…» в тексте
- [x] `activeProvider` сохраняется в `GlobalConfig`
- [x] Workspace'ы с `providerType != activeProvider` скрываются из панели (кэш `providerType` в `activeWorkspaces[]` заполняется из манифеста при attach / create / refresh)

---

## 5.2 Миграция между провайдерами (`VSCodeSync: Migrate to Another Provider`)

```
Миграция workspace'ов: OneDrive → Google Drive

  Будет перенесено:
    🗂 MyApp — авторизация    3 файла + 10 версий истории
    🗂 MyApp — оплата         5 файлов + 8 версий истории

  Шаги:
    1. Создать снапшот всех workspace'ов (автоматически)
    2. Авторизоваться в Google Drive
    3. Скопировать все файлы и манифесты
    4. Переключить activeProvider
    5. Опционально: удалить файлы со старого провайдера

  [Начать миграцию]  [Отмена]
```

- [x] Шаг 1: снапшот `VSCodeSyncFiles/.snapshots/pre-migration-<ISO>/` на **старом** провайдере (`cloudMigration.ts`, `providerMigrationUi.ts`)
- [x] Шаг 2: авторизация целевого провайдера (OneDrive — device code; Google Drive — device flow + `googleDriveClientId`; Dropbox — PKCE + loopback + `dropboxAppKey`; Яндекс — PKCE + loopback + `yandexOAuthClientId`)
- [x] Шаг 3: копирование всего экспортируемого дерева `VSCodeSyncFiles` (без предыдущих `pre-migration-*` архивов) на новый провайдер с теми же путями
- [x] Шаг 4: `activeProvider = new`; обновление `providerType` в каждом облачном манифесте; `repairLocalStateFromCloud` для открытых корней
- [x] Шаг 5: диалог удаления со старого облака после миграции (`providerMigrationUi.ts`, `deleteVsCodeSyncRootOnProvider` в `cloudMigration.ts`)
- [x] Старый провайдер: данные не удаляются автоматически (опционально по диалогу после миграции)
- [x] Финальное предупреждение о снапшотах `pre-migration-*` — в модальном диалоге шага 5 и в информационном сообщении при отказе от удаления

---

## Критерий готовности фазы

- [x] Все 4 провайдера работают через единый `ICloudProvider` интерфейс (реализации: OneDrive, Google Drive, Dropbox, **Яндекс Диск**)
- [x] OAuth flow для каждого провайдера — OneDrive, Google Drive, Dropbox, **Яндекс Диск** (PKCE + `oauth.yandex.ru`)
- [x] Миграция между провайдерами (MVP: бэкап + копия + патч манифестов; удаление со старого — опционально по диалогу после успеха) — см. §5.2
- [x] Integration-тесты с mock для каждого провайдера (`tests/integration/suite/index.ts`: цикл по типам + upload/list/download/delete)
