# Фаза 20: Modern bonus (v0.14)

> **Цель:** «модное» сверху ядра — то, что отличает индустри-стандарт от инди-расширения. Каждая подфаза независима и опциональна, но даёт ощутимый WOW-эффект при первом запуске.

**Зависимости:** v0.13 (DX baseline)
**Последняя фаза v1.**

---

## 20.1 VS Code Settings Sync wiring (F-060)

VS Code имеет встроенный Settings Sync (для themes / keybindings / settings). Наши `vscodesync.*` настройки идут туда автоматически (если scope=Global), но мы можем явно подружиться.

- [ ] Все наши настройки уже `Global` scope — sanity check
- [ ] Опционально: настройка `vscodesync.syncOwnSettings` (default `true`) — toggle участия в Settings Sync
- [ ] При first-run на новой машине показать «Подхватили N настроек VSCodeSync с другой машины»
- [ ] Documentation: README раздел про Settings Sync

## 20.2 Workspace template marketplace UI (F-061)

`workspaceTemplate.ts` и `workspaceTemplates.ts` уже существуют как skeleton (Phase 17.4 в v2 breakdown).

- [ ] Webview `templateMarketplacePanel.ts`:
  - Список templates с фильтром (kind: react, python, monorepo, ...)
  - Preview содержимого
  - "Use template" → новый workspace с прописанными ignore + workspace structure
- [ ] Registry URL: `vscodesync.templates.registryUrl` (default GitHub-hosted)
- [ ] Templates: JSON manifest + files tree
- [ ] Команда `vscodesync.openTemplateMarketplace`

## 20.3 Multi-account display в settings + status bar (F-062)

`multiAccountConfig.ts` + `multiAccountPickerFormatter.ts` уже есть.

- [ ] Status bar item показывает активный аккаунт provider'а: `OneDrive: alice@example.com`
- [ ] В Settings Panel секция «Аккаунты» с переключением между slots
- [ ] При нажатии — quick pick «Сменить аккаунт» (использует `formatMultiAccountQuickPick`)
- [ ] Per-workspace override (один workspace на личном OneDrive, другой — на корпоративном)
- [ ] Pure formatter уже unit-тестирован

## 20.4 Light/dark icon variants (F-063)

Текущие иконки status bar/tree используют codicons — наследуют тему. Но extension icon (`media/vscodesync.png`) — фиксированный.

- [ ] Создать `media/vscodesync-light.svg` + `media/vscodesync-dark.svg`
- [ ] В `package.json` указать `icon` (раздельные ссылки в contributions если поддерживается)
- [ ] Tree decoration icons тоже могут использовать `ThemeIcon` с light/dark variants

## 20.5 Quick switch UI improvements (F-064)

`quickSwitchWorkspace` — есть, но довольно базовое.

- [x] Pure scorer `buildQuickSwitchItems(workspaces, opts)`:
  - [x] Pinned поднимаются ★ + бонус +100k к score
  - [x] Активные > suspended > frozen > archived
  - [x] Внутри активных — по lastSyncMs desc (свежесинкавшиеся выше)
  - [x] Filter по note / tags / workspaceId (case-insensitive)
- [x] `renderSparkline(hourlyCounts)` — Unicode block chars
- [x] Human-readable detail: «1ч назад», «3д назад», «2нед назад» / «никогда не синкался»
- [x] Unit-тесты на сортировку, фильтр, sparkline, форматирование (`tests/unit/quickSwitchScorer.test.ts`)
- [ ] Wire в существующий `quickSwitchWorkspace` команду (deferred — UI replacement)
- [ ] User-pinned set в globalState (deferred — UI wiring)
- [ ] Hourly activity collection из Activity Feed (deferred — отдельный builder)
