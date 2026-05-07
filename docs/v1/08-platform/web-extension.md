# Web Extension

> Поддержка работы как web extension: `vscode.dev`, `github.dev`, Codespaces (web UI). Без Node.js API — только браузерные API.

**Часть фазы:** [08-platform](roadmap.md)

**Текущее состояние (v0):** отдельный entrypoint `extension.web.ts` — заглушки для **всех** команд из `package.json` (генерация списка `scripts/generate-web-stub-commands.mjs` → `src/webStubCommands.generated.ts`), дерево **Workspaces** с пояснением, **`registerUriHandler`** для будущего OAuth-callback. Полный sync по-прежнему только в Desktop.

---

## Entry point

- [x] Отдельный `extension.web.ts`
- [x] Сборка esbuild `platform=browser` → `dist/extension.web.js`
- [x] `package.json`: `"browser": "./dist/extension.web.js"`

---

## Замены Node.js API

| Desktop | Web |
|---------|-----|
| `node:crypto` | `SubtleCrypto` (`crypto.subtle.digest`, `crypto.subtle.encrypt`) |
| `node:zlib` | Web Compression API (`DecompressionStream`, `CompressionStream`) |
| `keytar` | `vscode.SecretStorage` (работает в web) |
| `node:fs` | `vscode.workspace.fs` |

- [x] Реализован `ICrypto` интерфейс: `src/core/platformCrypto.ts` — `createNodeCrypto()` (desktop) + `createWebCrypto()` (SubtleCrypto); wire-format совместим (IV(12) || ciphertext || authTag(16))
- [x] Реализован `ICompression` интерфейс: `src/core/platformCompression.ts` — `createNodeCompression()` (zlib) + `createWebCompression()` (CompressionStream)
- [x] Определять платформу: отдельные entrypoints (`extension.ts` для Desktop, `extension.web.ts` для web) — platform detection через bundling, не runtime check

CI: после сборки `npm run verify:web` проверяет отсутствие подстрок `node:` / `require("fs")` в `dist/extension.web.js`.

---

## OAuth в web

- [x] Заготовка: `vscode.window.registerUriHandler` — сообщение пользователю (полный OAuth + `openExternal` — позже)
- [x] Device Code Flow **недоступен** в web (нет terminal) → только browser-based OAuth _(в планах)_
- [x] Полный цикл с `vscode.env.openExternal` + redirect URI из `vscode.env.uriScheme`: `webOAuthGetCode()` + `buildWebOAuthRedirectUri()` + `registerUriHandlerWeb()` в `extension.web.ts`

---

## Ограничения web-версии

- [x] Нет CLI-компаньона
- [x] Нет Device Code Flow
- [x] Lock-файл: `acquireWebLock()` + `releaseWebLock()` через `vscode.workspace.fs`; instanceId вместо PID
- [x] `powerMonitor` (battery/metered): stub `webPowerMonitorStub` — авто-пауза отключена в web, интерфейс сохранён
- [x] Git extension интеграция: `getWebGitBranch()` через `vscode.git` extension API (best-effort)

---

## Тестирование

- [x] Unit-тесты ICrypto (Node + Web): `tests/unit/platformCrypto.test.ts` — contract (encrypt/decrypt, wrong-key throws, tamper) + cross-platform Node↔Web
- [x] Unit-тесты ICompression (Node + Web): `tests/unit/platformCompression.test.ts` — round-trip, threshold, cross-platform, wireCompression.ts format compatibility
- [x] Unit-тесты web-specific утилит: `tests/unit/webExtensionUtils.test.ts` — powerMonitorStub, OAuth URL/state parsing, lock-file body, smee.io SSE parsing, E2E pipeline (compress+encrypt → decrypt+decompress) для Node/Web/Cross-platform
- [x] Убедиться что нет прямых `require('node:...')` в web bundle — `scripts/verify-web-bundle.mjs` в CI
- [~] E2E тест на `vscode.dev` с реальным OneDrive — **manual-only** (по контракту /roadmap-max — skeleton-acceptable; E2E на browser deployments в default-списке). Автоматизация невозможна без публичного deployment + сервисного OneDrive-аккаунта. Шаги ручного прогона: открыть https://vscode.dev → установить расширение из Marketplace → войти в OneDrive → создать workspace → закрыть/открыть вкладку → проверить, что состояние восстановилось.
