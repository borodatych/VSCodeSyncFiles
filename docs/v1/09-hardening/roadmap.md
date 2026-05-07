# Phase 9 — Hardening

> Жёсткая чистка после фаз 1–8: баг-фиксы из аудита, дедуп, lint=0, dx-инфраструктура.
> См. также: [`CHANGELOG.md`](../../../CHANGELOG.md), [`SECURITY.md`](../../../SECURITY.md).

## Статус: `[x]` (закрыто в этой сессии)

## Что сделано

### Баг-фиксы

- [x] `src/extension.web.ts:104` — `getExtension("vscodesync.vscodesync")` → `getExtension("borodatych.vscodesyncfiles")`. Старый ID никогда не резолвился; OAuth UriHandler в web теперь жизнеспособен.
- [x] `src/ui/webhookTunnel.ts` — `dispose()` через `AbortController` + `state.disposed` через объект-геттер. Eslint больше не считает флаг недостижимым; SSE-стрим прерывается мгновенно, реконнект-цикл не идёт после dispose.
- [x] `src/ui/oneDriveWebhookLifecycle.ts:166` — удалена тавтологическая ветка `gc.activeProvider === "onedrive"` (после `if (… !== "onedrive") return` уже narrowed).
- [x] `src/core/syncEngine.ts:1786` — rename meta-entry без `delete` (через destructure `…rest`); устранил `no-dynamic-delete`.
- [x] `src/core/syncEngine.ts:73` — sentinel `\x00` в `minimatchGlob` заменён на ``; `no-control-regex` устранён.
- [x] `src/core/writeTextFileAtomic.ts` — fallback при EPERM теперь делает unlink+rename перед последним `writeFile`; новые байты остаются в `tmp` пока swap не пройдёт (раньше прямой `writeFile` мог потерять и старую, и новую версию).
- [x] `src/utils/normalize.ts` — `normalizeLineEndings` за один regex-pass (`\r\n|\r|\n`).
- [x] `src/ui/graphWebhookLocalServer.ts` — `MAX_WEBHOOK_BODY_BYTES = 64 KB` лимит с проверкой `Content-Length` и runtime cut-off на 413; устранён DoS-вектор.
- [x] `src/providers/yandex/yandexPkceOAuth.ts` — устранены: «Async arrow no await», «inferrable type», `no-unsafe-argument` на Buffer; `tests/unit/yandexPkceOAuth.test.ts` (если будет добавлен — фаза 11).

### Чистка `console.*` в hot-path

- [x] `src/utils/log.ts` — централизованный logger без `vscode`-зависимостей (для CLI/тестов).
- [x] `src/utils/logVscode.ts` — VS Code-обвязка (создаёт `OutputChannel "VSCodeSync · Diagnostics"`, читает `notificationLevel`).
- [x] Заменены `console.log/warn/info` на `verboseLog/warnLog/errorLog` в:
  - `src/core/syncEngine.ts` (soft-lock hot-path)
  - `src/extension.ts` (`runWithEngine`, startup pull)
  - `src/providers/yandex/yandexDiskProvider.ts` (network logs)
  - `src/ui/syncTriggerManager.ts`, `src/ui/quietFullSyncAllFolders.ts`
- [x] `initLog(context)` вызывается в `extension.ts → activate(...)` и регистрирует канал в `subscriptions`.

### Дедуп / архитектура

- [x] `src/providers/_shared/pkceLoopbackOAuth.ts` — общий PKCE-loopback флоу (HTTP-сервер, state, timeout, EADDRINUSE).
- [x] OneDrive / Google Drive / Dropbox PKCE OAuth переписаны как тонкие обёртки над shared (~600 LoC дедупа).
- [x] Yandex остаётся отдельно: implicit flow с HTML shim не вписывается в shared.

### Конфигурация и CommandPalette

- [x] `vscodesync.fileEncoding` удалён из `package.json` (был enum `["utf8"]` — настройка ни на что не влияла).
- [x] `vscodesync.conflictRules` схема исправлена: было `array of string`, стало `array of object {pattern, strategy}` — теперь матчит то, что реально читает `syncEngine.ts:153`.
- [x] Удалён дубликат `vscodesync.migrateProvider` (заглушка → executeCommand → `migrateToAnotherProvider`); пользователь больше не видит два одинаковых пункта в палитре.

### Lint

- [x] `eslint.config.mjs` — добавлены `argsIgnorePattern: "^_"`, `varsIgnorePattern: "^_"`, `caughtErrorsIgnorePattern: "^_"`, `destructuredArrayIgnorePattern: "^_"`.
- [x] `tsconfig.json` — `lib` дополнен `WebWorker` (для `CryptoKey`, `CompressionStream`, `ReadableStream`); type-shim для `vscode.lm` в `aiMerge.ts`.
- [x] `npm run lint` → **0 errors, 0 warnings** (исходно 169).

### DX-инфраструктура

- [x] `CHANGELOG.md` — Keep a Changelog формат; обязательно для VS Code Marketplace «What's New».
- [x] `SECURITY.md` — responsible disclosure email, smee.io disclaimer, политика по public OAuth client IDs.
- [x] `.editorconfig` — LF/UTF-8 для исходников, CRLF для `*.bat` / `*.ps1`.
- [x] `.gitignore` — `docs/v1/` и `docs/v2/` теперь версионируются (раньше всё `docs/` игнорировалось); `docs/idea.md` остаётся локальным черновиком.

### Артефакты

- [x] `nul` (0 байт в корне) удалён.

## Не сделано / отложено

- [x] **husky + lint-staged** — установлены `husky@^9` + `lint-staged@^15`. `.husky/pre-commit` запускает `npx lint-staged`; `.lintstagedrc.json` гоняет `eslint --fix` по staged `*.{ts,tsx,mjs,cjs,js}`. `scripts.prepare: husky` авто-инициализирует hooks при `npm install`.
- [ ] **Stale flaky tests** (8 штук) на main — `attachCloudWorkspace`, `conflictResolution`, `engineCallbacks`, `platformCrypto decrypt with wrong key`. Падали и до правок Волны 1; не регрессии этой фазы. См. отдельный bug в Phase 11.
