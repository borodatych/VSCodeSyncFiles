# vscodesync-cli

Публикуемый npm-пакет (метаданные в этом каталоге). Сборка артефакта из корня репозитория:

```bash
npm run compile
node cli/dist/cli.cjs --help
```

Опционально для движка (pull): `VSCODESYNC_DELTA_SYNC=true`, `VSCODESYNC_DELTA_THRESHOLD_KB` — см. §8.2 в документации платформы.

Подробнее: [docs/v1/08-platform/cli.md](../docs/v1/08-platform/cli.md).
