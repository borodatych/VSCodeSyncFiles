# CLI-компаньон (`vscodesync-cli`)

> Отдельный npm-пакет для операций без открытого VSCode. CI/CD пайплайны, скрипты деплоя, автоматизация.

**Часть фазы:** [08-platform](roadmap.md)

Локальная сборка из монорепозитория: `npm run compile` → запуск `node cli/dist/cli.cjs --help`. Публикация npm-пакета — из каталога `cli/` с предварительной сборкой артефакта `dist/cli.cjs`.

---

## Команды

```bash
npx vscodesync pull --workspace a3f8c1d2
npx vscodesync push src/config/nginx.conf
npx vscodesync push --workspace a3f8c1d2
npx vscodesync push-all
npx vscodesync pull-all
npx vscodesync transfer src/.env --to work
npx vscodesync list
npx vscodesync list --workspaces
npx vscodesync auth --provider onedrive
npx vscodesync auth --device-code
npx vscodesync status
npx vscodesync create-snapshot --workspace a3f8c1d2 --name "before-deploy"
```

---

## Реализация

- [x] Отдельный npm-пакет `vscodesync-cli` (`cli/package.json`, сборка `cli/dist/cli.cjs` через корневой `npm run compile`)
- [x] Переиспользует core-логику из основного расширения (esbuild-бандл подтягивает `src/core/*`, провайдер OneDrive)
- [x] Читает тот же `~/.vscode/vscodeSync/config.json` и workspace-конфиги
- [x] Токены из системного keychain через `keytar` (опциональная зависимость): `createKeytarSecretStore()` в `cli/src/credentialStore.ts`; `createAutoSecretStoreAsync()` — приоритет env → keytar → файл; esbuild `external: ["keytar"]` — fallback при отсутствии

---

## Non-interactive auth (CI/CD)

- [x] Флаг `--token <access_token>` для явного токена (pull / pull-all; приоритет над `VSCODESYNC_TOKEN`)
- [x] Переменная `VSCODESYNC_TOKEN` (аналог флага — Bearer для Graph / OneDrive)
- [x] Device Code Flow: `npx vscodesync auth --device-code [--provider onedrive] [--client-id <id>]`
  - Показывает код пользователю, polling до авторизации
  - Токен сохраняется в `~/.vscode/vscodeSync/cli-credentials.json`
  - `pull` / `pull-all` автоматически подхватывают credentials-файл (env `VSCODESYNC_TOKEN` — приоритет)
- [x] При истечении токена в non-interactive режиме → exit code `2` + диагностика в stderr

---

## Exit Codes

| Code | Значение |
|------|----------|
| 0 | Успех |
| 1 | Общая ошибка |
| 2 | Ошибка авторизации / истёкший токен |
| 3 | Conflict (нужно разрешить вручную) |
| 4 | Workspace не найден |

---

## Пример CI/CD сценария

```yaml
# GitHub Actions: получить конфиг с облака перед деплоем
- name: Pull nginx config
  env:
    VSCODESYNC_TOKEN: ${{ secrets.VSCODESYNC_TOKEN }}
  run: npx vscodesync pull --workspace c2d8a31f
```

---

## Workspace Trust в CLI

- [x] В CLI нет Workspace Trust (VS Code API недоступен); операции с файлами выполняются без ограничений — документировано

---

## Unit-тесты

- [x] CLI парсинг аргументов (`tests/unit/cliParseArgs.test.ts`; включая `auth`)
- [x] Non-interactive auth flow (mock) — `tests/unit/cliExitCodes.test.ts`
- [x] Exit codes для всех сценариев ошибок — `tests/unit/cliExitCodes.test.ts`
- [x] Credential store (file-backed SecretStore) — `tests/unit/cliCredentialStore.test.ts`
