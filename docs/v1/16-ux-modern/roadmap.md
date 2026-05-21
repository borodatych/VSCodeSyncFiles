# Фаза 16: UX & Modern (v0.10)

> **Цель:** инструменты, которые ожидаются от современных IDE-расширений 2026 года: drag-and-drop, URI-схема, контекстуальные хинты, AI-аугментация существующих flow. Никакого нового кода для функций, которые уже есть — только дотягивание UX.

**Зависимости:** v0.9 (наблюдаемость) — некоторые хинты используют sync state explainer
**Следующая фаза:** [17-finish-underbaked](../17-finish-underbaked/roadmap.md)

---

## 16.1 First-run banner для autoSyncMode=check-only (F-020)

- [ ] При первом обнаружении `pending_push` / `cloud_newer` (через `WorkspacesTreeProvider`) в режиме `check-only`:
  - Показать однократный info-popup: «VSCodeSync обнаружил N файлов с изменениями. {kind}: Push всё / Pull всё / Открыть режим / Always-Full»
  - Сохранить выбор в globalState (`autoSyncMode.firstRunBannerShown = true`)
  - Кнопка «Always-Full» → обновляет setting в Global scope
- [ ] Тест на состояние globalState (не показывать повторно)

## 16.2 Drag-and-drop из Explorer в Workspaces tree (F-021)

- [ ] Расширить `WorkspacesTreeDnD`: accept `text/uri-list` MIME (drop из VS Code Explorer)
- [ ] Route в `addFileToWorkspace(targetWsId, uris)`
- [ ] Visual feedback: hover-подсветка target node
- [ ] При drop на pseudo-node «новый workspace» — открыть quick pick для имени
- [ ] Тест: simulated DnD событие → `addFile` вызван с правильным workspaceId

## 16.3 `vscodesync://` URI scheme (F-022)

- [ ] Зарегистрировать `vscode.window.registerUriHandler({ handleUri })` в `extension.ts` (deferred — UI wiring)
- [x] Парсер `parseVscodeSyncUri(uri)`:
  - `vscodesync://workspace/<wid>/<rel>` → открыть файл (attach workspace если нужно)
  - `vscodesync://workspace/<wid>` → показать tree node
  - `vscodesync://command/<id>` → execute command (whitelist)
- [ ] Команда `vscodesync.copyShareUri` (right-click на файле в tree) копирует URI в clipboard (deferred)
- [x] Pure parser + builder unit-тесты на malformed URI + roundtrip (`tests/unit/vscodesyncUriParser.test.ts`)
- [x] Hard whitelist команд для `vscodesync://command/...` (без destructive)
- [ ] Документация в README (deferred)

## 16.4 Animated tree decorators per-file (F-023)

- [ ] Расширить `SyncFileDecorationController` поддержкой состояния `syncInProgress` per-rel (Set<workspaceId#rel>)
- [ ] При `pushFile` / `pullFile` start: добавить в Set, fire decoration change
- [ ] При finish/fail: удалить из Set
- [ ] Badge `↑` для push-in-progress, `↓` для pull-in-progress (через ThemeIcon)
- [ ] Snapshot test на decoration state machine

## 16.5 AI Explain Conflict (F-024)

- [ ] Команда `vscodesync.aiExplainConflict <uri>` (deferred — UI wiring + LM session)
- [x] Prompt builder в `core/aiExplainConflictPrompt.ts` (pure)
- [x] `normaliseConflictExplanation` для пост-обработки LM-output
- [ ] Использует Copilot LM (как aiSessionSummary / aiCommitMessage) (deferred — session glue)
- [x] Структура: 2-3 строки intent (LOCAL/REMOTE/recommendation) — закреплено в system prompt
- [ ] Отображение в Conflict panel + новый action в resolveConflicts QuickPick (deferred)
- [x] Pure prompt unit tests на формат вывода (`tests/unit/aiExplainConflictPrompt.test.ts`)
- [ ] Setting `vscodesync.ai.explainConflict.enabled` (default `true`) (deferred)

## 16.6 Auto-derive Command Center из package.json (F-025)

- [ ] В `commandCenter.ts` заменить hardcoded entries на runtime read `vscode.extensions.getExtension(EXT_ID).packageJSON.contributes.commands`
- [ ] Группировка по эмодзи-префиксу в title (📦 → "Workspaces", 🔧 → "Tools", ...)
- [ ] User-pinned entries сохраняются в globalState (`commandCenter.pinned: string[]`)
- [ ] Тест: при добавлении нового command в `package.json` он появляется в Command Center без правки кода

## 16.7 Контекстуальные хинты (F-026)

- [x] Pure-планнер `planContextualHints(state)`:
  - [x] >5 файлов в conflict status → hint «Resolve All Conflicts»
  - [x] Все workspace'ы frozen → hint «Unfreeze All»
  - [x] Quota >90% (после F-002) → hint «Cleanup Heavy Files»
  - [x] autoSyncMode=off >7 дней → hint «Sync was paused for a week — review pending»
- [ ] Output через `vscode.window.showInformationMessage` с однократным dedup (deferred — UI wiring)
- [ ] Setting `vscodesync.hints.enabled` (default `true`) (deferred)
- [ ] Триггер: на `vscode.window.onDidChangeWindowState` (focus regained) (deferred)
- [x] Unit-тесты на каждое из 4 правил (`tests/unit/contextualHintsPlanner.test.ts`)
