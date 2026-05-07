# VSCodeSync — Roadmap

Расширение для VSCode: синхронизация отдельных файлов между машинами через облачный диск (OneDrive, Google Drive, Яндекс Диск, Dropbox).

## Версии

- **[v1 →](v1/roadmap.md)** — первая полноценная версия расширения

## Быстрая ссылка на текущий статус

→ [docs/v1/roadmap.md](v1/roadmap.md)

**Сделано:** все фазы 1–8 полностью закрыты. **7.8 (UX):** добавление в sync целой папки рекурсивно; **7.9 (UX):** «Добавить в новый воркспейс» из ПКМ. Последняя сессия: ICrypto/ICompression интерфейсы (desktop+web), Delta Sync rolling-hash алгоритм (CDC + compression), OneDrive Upload Session (>4MB), OneDrive PKCE OAuth, AI merge (vscode.lm), RequestQueue глобальный, smee.io webhook tunnel, CLI keytar, Web OAuth/lock/powerMonitor/git stubs, тесты platformCrypto + deltaSyncAlgorithm. **262 теста прошли.** v1 опубликована в Marketplace (publisher: VSCodeSync, v0.2.17). README на русском, иконка, дефолтные Client ID для Яндекс Диска и Dropbox, подробные инструкции по настройке провайдеров. Hotfix v0.2.23: исправлен баг в Яндекс Диск провайдере — при включённой "Папке приложения" пути в облаке возвращались как полные disk-пути (`Приложения/VSCodeSync/VSCodeSyncFiles/...`), из-за чего `directChildFolderIds` не находил воркспейсы и "Подключить с облака" возвращал пустой список.

**Частично по подмодулям Core Sync:** см. [фазу 2](v1/02-core-sync/roadmap.md).

**Заметки при смене чата / агента:** [docs/continuity.md](continuity.md).
