# Фаза 1: Foundation

> **Цель:** рабочий скелет расширения без реальной синхронизации. После этой фазы: расширение активируется в VSCode, читает/пишет конфиги, умеет хэшировать файлы, имеет готовый интерфейс провайдера.

**Зависимости:** нет  
**Следующая фаза:** [02-core-sync](../02-core-sync/roadmap.md)

---

## 1.1 Скаффолдинг проекта

- [x] Инициализировать npm-пакет (`package.json`, `engines.vscode: "^1.80.0"`)
- [x] Настроить TypeScript (`tsconfig.json`, strict mode)
- [x] Настроить esbuild (отдельные entrypoints: `extension.ts`, `extension.web.ts`)
- [x] Настроить ESLint + `@typescript-eslint`
- [x] Настроить vitest для unit-тестов
- [x] Настроить `@vscode/test-electron` для интеграционных тестов
- [x] Настроить GitHub Actions CI: lint → test → `vsce package`
- [x] Создать базовую структуру директорий:
  ```
  src/
    extension.ts          ← desktop entry point
    extension.web.ts      ← web entry point
    core/                 ← бизнес-логика (без VSCode API)
    providers/            ← реализации облачных провайдеров
    ui/                   ← вью, панели, команды
    utils/                ← хэши, нормализация, misc
  tests/
    unit/
    integration/
  ```
- [x] Базовый `contributes` в `package.json` (команды-заглушки, activationEvents)
- [x] Подтвердить что расширение активируется без ошибок

---

## 1.2 Глобальный конфиг-менеджер

> Файл: `~/.vscode/vscodeSync/config.json`

- [x] Определить TypeScript-интерфейс `GlobalConfig`:
  ```typescript
  interface GlobalConfig {
    activeProvider: ProviderType | null;
    machineId: string;
    machineName: string;
    providers: Partial<Record<ProviderType, ProviderTokens>>;
  }
  ```
- [x] Реализовать `GlobalConfigManager`:
  - `load()` — читает файл или возвращает дефолт
  - `save(config)` — атомарная запись (write to temp + rename)
  - `get<K>(key)` / `set<K>(key, value)`
- [x] Генерация `machineId` (UUID v4) при первом запуске, сохранение в конфиг
- [x] Токены хранятся в `vscode.SecretStorage` (не в файле); `config.json` хранит только метаданные провайдера
- [x] Unit-тесты: load/save/defaults/atomic write

---

## 1.3 Workspace-конфиг менеджер

> Файл: `{projectRoot}/.vscode/vscodesync.json`

- [x] Определить TypeScript-интерфейс `WorkspaceConfig`:
  ```typescript
  interface WorkspaceConfig {
    activeWorkspaces: ActiveWorkspaceEntry[];
    files: TrackedFile[];
  }
  interface ActiveWorkspaceEntry {
    workspaceId: string;
    workspaceNote: string;
    saveDebounceSec?: number;
    ignorePatterns?: string[];
    manifestEtag?: string;
  }
  interface TrackedFile {
    localPath: string;       // нормализован к "/"
    workspaceId: string;
    cloudPath: string;
    lastSync: string;        // ISO 8601
    localHash: string;       // SHA-256 от нормализованной санированной версии
    // Link Bindings (docs/v2/linkBindings.md, 2026-08-11):
    manifestPath?: string;   // канонический ключ манифеста/_meta; отсутствует ⇒ равен localPath —
                             // все конфиги до фичи валидны без миграции; читать через manifestKeyOf
    linkId?: string;         // кэш идентичности облачной строки
  }
  ```
- [x] Реализовать `WorkspaceConfigManager`:
  - `load(workspaceRoot)` — читает файл или возвращает дефолт
  - `save(config, workspaceRoot)` — атомарная запись
  - Определение `workspaceRoot` через `vscode.workspace.workspaceFolders`
- [x] Автоматически добавлять `.vscode/vscodesync.json` в `.gitignore`:
  - Проверить wildcard-покрытие перед добавлением
  - Показать уведомление при добавлении
  - Предложить создать `.gitignore` если отсутствует
- [x] Unit-тесты: load/save/gitignore logic

---

## 1.4 Утилиты файлов и хэширования

- [x] Нормализация path separator: `\` → `/` при записи, `/` → `\` при чтении на Windows
- [x] Нормализация line endings (`normalize(content, mode: 'lf' | 'crlf' | 'preserve')`)
- [x] Sanitize syncignore-блоков (вырезать `vsync-ignore-start` ... `vsync-ignore-end`)
- [x] SHA-256 хэш от `normalize(sanitize(content))`:
  ```typescript
  function computeHash(filePath: string, config: HashConfig): Promise<string>
  ```
- [x] Определить `CanonicalPipeline` тип (порядок операций для push/pull):
  ```
  Push: normalize → sanitize → hash → [compress] → [encrypt] → upload
  Pull: download → [decrypt] → [decompress] → merge_syncignore → write
  ```
- [x] Определение бинарного файла по MIME/расширению
- [x] Unit-тесты: hash consistency Windows↔Linux, syncignore strip/merge

---

## 1.5 Интерфейс провайдера

> Абстракция для всех облачных провайдеров.

- [x] Определить интерфейс `ICloudProvider`:
  ```typescript
  interface ICloudProvider {
    readonly type: ProviderType;
    isAuthenticated(): Promise<boolean>;
    authenticate(): Promise<void>;
    logout(): Promise<void>;
    uploadFile(cloudPath: string, content: Buffer, etag?: string): Promise<UploadResult>;
    downloadFile(cloudPath: string): Promise<DownloadResult>;
    getMetadata(cloudPath: string): Promise<FileMetadata | null>;
    deleteFile(cloudPath: string): Promise<void>;
    listFolder(cloudPath: string): Promise<FileMetadata[]>;
    createFolder(cloudPath: string): Promise<void>;
  }
  ```
- [x] Определить вспомогательные типы: `UploadResult`, `DownloadResult`, `FileMetadata`, `ProviderError`
- [x] Определить `ProviderError` с кодами: `NOT_FOUND`, `UNAUTHORIZED`, `PRECONDITION_FAILED` (412), `RATE_LIMITED` (429), `NETWORK_ERROR`
- [x] Реализовать `ProviderRegistry` (регистрация и получение активного провайдера)
- [x] Unit-тесты с mock-провайдером

---

## Критерий готовности фазы

- [x] Расширение активируется в VSCode без ошибок
- [x] Все unit-тесты проходят
- [x] TypeScript компилируется без ошибок
- [x] ESLint без предупреждений
