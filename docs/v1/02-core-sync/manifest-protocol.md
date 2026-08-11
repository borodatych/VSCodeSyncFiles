# Протокол манифеста

> Спецификация формата `.vscodesync-workspace.json` и `_meta.json`, правила merge, Lamport timestamps, ETag.

**Часть фазы:** [02-core-sync](roadmap.md)

---

## Формат `.vscodesync-workspace.json`

```typescript
interface CloudManifest {
  schemaVersion: 1;
  workspaceId: string;
  workspaceNote: string;
  tags: string[];
  gitBranch?: string;
  sharedIgnorePatterns: string[];
  providerType: ProviderType;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  machines: MachineEntry[];
  files: ManifestFile[];
  // Link Bindings (docs/v2/linkBindings.md): пер-машинные ПАПОЧНЫЕ правила —
  // machineId → канонический префикс → { path: локальный префикс, boundAt }.
  // Merge: по-(машина, префикс) LWW на boundAt, Lamport не участвует.
  folderBindings?: Record<string, Record<string, BindingEntry>>;
}

interface BindingEntry {
  path: string;            // локальное размещение (posix, относительно sync root машины)
  boundAt: string;         // LWW-ключ merge
}

interface ManifestFile {
  path: string;            // КАНОНИЧЕСКИЙ путь: ключ merge и адрес blob; нормализован к "/"
  addedAt: string;
  version: number;         // Lamport timestamp
  removedAt?: string;      // null если активен
  renamedFrom?: string;
  renamedAt?: string;
  hasSyncignoreMarkers: boolean;
  editingBy?: string;      // machineId если открыт для редактирования (Soft Lock)
  editingSince?: string;
  // Link Bindings — все три поля необязательные, schemaVersion не бампался:
  linkId?: string;         // стабильная идентичность (16 hex); легаси-строки — детерминированный
                           // бэкфилл sha256(path+"\0"+addedAt) на write-path, БЕЗ bump version
  linkName?: string;       // линковочное имя — человеческая метка, не ключ, коллизии допустимы
  bindings?: Record<string, BindingEntry>; // machineId → размещение файла на той машине;
                           // merge по-ключевой (LWW на boundAt); отвязка = запись канонического
                           // значения, НЕ удаление ключа (union воскресил бы его)
}

interface MachineEntry {
  machineId: string;
  machineName: string;
  lastSeen: string;
  status?: 'active' | 'pending' | 'blocked';  // для Machine Approval (v1 optional)
}
```

---

## Формат `_meta.json`

```typescript
interface MetaJson {
  files: Record<string, MetaEntry>;  // ключ = нормализованный путь
}

interface MetaEntry {
  hash: string;         // SHA-256 от нормализованной санированной версии
  etag: string;         // ETag облачного файла
  version: number;      // Lamport timestamp
  machineId: string;    // кто последний пушил
  updatedAt: string;    // ISO 8601
}
```

---

## Push манифеста

Манифест пушится **только при изменении структуры** (не при каждом save файла):
- добавление файла в workspace
- удаление / отвязка файла
- переименование файла
- изменение тегов, gitBranch, sharedIgnorePatterns
- обновление `editingBy` (Soft Lock)
- обновление `lastSeen` машины

### Алгоритм push манифеста (с merge):

```
1. GET текущего манифеста с облака (сохранить ETag)
2. Merge локального и облачного:
   - files[] объединяются по path
   - При конфликте записи: побеждает та у которой больше version
   - При равных version: побеждает та у которой новее updatedAt
   - Удалённые файлы: помечаются removedAt (не физически удаляются)
3. PUT объединённого манифеста с If-Match: <etag>
4. При 412 → повторить с шага 1 (backoff: 100ms → 200ms → 400ms, max 3 попытки)
```

- [x] `mergeManifestFiles` / `mergeCloudManifests` в `src/core/manifestMerger.ts` — Lamport по `version`, tiebreaker `updatedAt`/`addedAt`
- [x] Unit-тесты: `tests/unit/manifestMerger.test.ts`

---

## Conditional GET (оптимизация startup)

- [x] `manifestEtag` в `activeWorkspaces[]` (`activeWorkspaces[].manifestEtag`)
- [x] `downloadManifest(wsId, ifNoneMatch)` → `If-None-Match: <cached_etag>` → `304 Not Modified` → cache hit
- [x] `metaEtag` аналогично для `_meta.json` (`pullMeta` с Conditional GET)

---

## Forward compatibility (`schemaVersion`)

- [x] `attachCloudWorkspace`: бросает ошибку при `schemaVersion !== SUPPORTED_MANIFEST_SCHEMA`
- [x] `repairLocalStateFromCloud`: аналогично
- [x] Read-only режим для уже подключённых workspace при `schemaVersion` выше поддерживаемой:
  - [x] `onSchemaVersionTooNew` callback в `SyncEngineDeps` — вызывается из `syncWorkspace`
  - [x] UI: `showWarningMessage` + кнопка «Проверить обновления»; sync для этого workspace пропускается (return)
  - [x] Dedupe: `warnedSchemaVersionKeys` Set (session-level)
  - [x] Детект в `syncWorkspace`: если `manifest.schemaVersion > SUPPORTED_MANIFEST_SCHEMA` → вызов `onSchemaVersionTooNew` callback + `return` (skip sync)
  - [x] Callback в `makeEngine`: `showWarningMessage` с dedupe (`warnedSchemaVersionKeys`) + кнопка «Проверить обновления»

---

## ETag для `_meta.json`

- [x] `pushMetaJson(workspaceId, meta, ifMatch)` → `If-Match: <saved_etag>` на каждый PUT
- [x] При `412 PRECONDITION_FAILED`: скачать свежий `_meta`, смёрджить `mergeMetaEntries` (по `version`), повторить (до 3 попыток)
- [x] `mergeMetaEntries` в `src/core/metaMerge.ts`

---

## Lamport timestamp (`version`)

- [x] Каждая запись в `ManifestFile.version` — монотонный счётчик
- [x] `nextManifestVersion(files)` = max(version) + 1 при каждом изменении
- [x] При merge: `maxVersion(a, b)` → больший version побеждает, tiebreaker — `addedAt`
- [x] `version` = 1 при создании записи

---

## `providerType` validation

- [x] `attachCloudWorkspace`: читает `manifest.providerType`, кэширует в `activeWorkspaces[].providerType`
- [x] Предупреждение в UI при несовпадении `providerType` манифеста vs активный провайдер (extension.ts — в `connectCloudWorkspace`)

---

## Глобальный реестр машин (`_machines.json`)

- [x] Структура:
  ```json
  [{ "machineId": "...", "machineName": "...", "lastSeen": "..." }]
  ```
- [x] При старте расширения: read-modify-write с ETag (обновить свою запись) — см. `syncMachinesRegistrySelf` в `src/core/machineRegistry.ts`
- [x] При записи: удалить машины не видевшиеся > 90 дней
- [x] Уникальность `machineName`: при коллизии предложить постфикс `"-2"` (онбординг + облачный реестр)
- [x] Используется для Quick Transfer адресации: `readMachinesRegistrySafe` в `quickTransferUi.ts` — quick-pick целевой машины из реестра
