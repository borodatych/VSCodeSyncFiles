# vscodesync-cli

Публикуемый npm-пакет (метаданные в этом каталоге). Сборка артефакта из корня репозитория:

```bash
npm run compile
node cli/dist/cli.cjs --help
```

Опционально для движка (pull): `VSCODESYNC_DELTA_SYNC=true`, `VSCODESYNC_DELTA_THRESHOLD_KB` — см. §8.2 в документации платформы.

## Зашифрованные воркспейсы

CLI не имеет доступа к SecretStorage VS Code, поэтому ключ шифрования передаётся явно:

```bash
export VSCODESYNC_ENCRYPTION=1
export VSCODESYNC_ENCRYPTION_KEY="<тот же ключ, что у расширения, в base64 — 32 байта>"
```

Если объявить `VSCODESYNC_ENCRYPTION=1` и не передать ключ, CLI **откажет** в любой
операции с файлами. Это намеренно: раньше CLI собирал движок вообще без
`encrypt`/`decrypt`, и `vscodesync pull` на зашифрованном воркспейсе молча
перезаписывал рабочие файлы шифротекстом.

Подробнее: [docs/v1/08-platform/cli.md](../docs/v1/08-platform/cli.md).
