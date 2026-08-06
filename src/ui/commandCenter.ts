/**
 * VSCodeSync Command Center — интерактивный webview с кнопками для всех команд.
 * Команды разбиты по разделам; клик на кнопку выполняет vscode-команду через postMessage.
 */
import * as vscode from "vscode";

export function registerCommandCenter(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.showCommandCenter", () => {
      const panel = vscode.window.createWebviewPanel(
        "vscodesyncCommandCenter",
        "VSCodeSync: Command Center",
        vscode.ViewColumn.One,
        { enableScripts: true },
      );

      panel.webview.html = getCommandCenterHtml();

      // Receive command requests from webview
      panel.webview.onDidReceiveMessage(
        async (msg: { command: string; args?: unknown[] }) => {
          try {
            if (msg.args && msg.args.length > 0) {
              await vscode.commands.executeCommand(msg.command, ...msg.args);
            } else {
              await vscode.commands.executeCommand(msg.command);
            }
          } catch (e) {
            void vscode.window.showErrorMessage(
              `VSCodeSync: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
        undefined,
        context.subscriptions,
      );
    }),
  );
}

interface CmdGroup {
  title: string;
  icon: string;
  items: CmdItem[];
}

interface CmdItem {
  label: string;
  desc: string;
  cmd: string;
  style?: "primary" | "danger" | "secondary";
}

const GROUPS: CmdGroup[] = [
  {
    title: "Авторизация и провайдер",
    icon: "🔑",
    items: [
      { label: "Сменить провайдер", desc: "Переключить OneDrive / Яндекс Диск / Google Drive / Dropbox", cmd: "vscodesync.setActiveProvider", style: "primary" },
      { label: "Войти в Яндекс Диск", desc: "OAuth через браузер (authorization code + PKCE)", cmd: "vscodesync.yandexDiskSignIn" },
      { label: "Ввести токен Яндекса вручную", desc: "Вставить токен из oauth.yandex.ru", cmd: "vscodesync.yandexDiskEnterToken" },
      { label: "Войти в OneDrive", desc: "браузер (PKCE + loopback)", cmd: "vscodesync.onedriveSignInBrowser" },
      { label: "Войти в Google Drive", desc: "браузер (PKCE + loopback)", cmd: "vscodesync.googleDriveSignInBrowser" },
      { label: "Войти в OneDrive — код устройства", desc: "если браузер недоступен", cmd: "vscodesync.onedriveSignIn" },
      { label: "Войти в Google Drive — код устройства", desc: "если браузер недоступен", cmd: "vscodesync.googleDriveSignIn" },
      { label: "Войти в Dropbox", desc: "PKCE loopback", cmd: "vscodesync.dropboxSignIn" },
      { label: "Инструкции по настройке", desc: "Пошаговые гайды по всем провайдерам", cmd: "vscodesync.showProviderSetupGuide" },
    ],
  },
  {
    title: "Workspace",
    icon: "📁",
    items: [
      { label: "Создать Workspace", desc: "Новый workspace с шаблоном файлов", cmd: "vscodesync.createWorkspace", style: "primary" },
      { label: "Подключить с облака", desc: "Connect to Cloud Workspace", cmd: "vscodesync.connectCloudWorkspace" },
      { label: "Отвязать (локально)", desc: "Detach — облако не трогает", cmd: "vscodesync.detachWorkspace" },
      { label: "Удалить с облака", desc: "Удалить папку workspace из облачного хранилища", cmd: "vscodesync.deleteWorkspaceFromCloud", style: "danger" },
      { label: "Переименовать", desc: "Rename Workspace Note", cmd: "vscodesync.renameWorkspaceNote" },
      { label: "Экспортировать структуру", desc: "Сохранить список файлов workspace в JSON", cmd: "vscodesync.exportWorkspaceStructure" },
      { label: "Импортировать структуру", desc: "Подключить или создать workspace из JSON", cmd: "vscodesync.importWorkspaceStructure" },
    ],
  },
  {
    title: "Синхронизация",
    icon: "☁",
    items: [
      { label: "Sync Workspace", desc: "Push + Pull — полная синхронизация", cmd: "vscodesync.syncWorkspace", style: "primary" },
      { label: "Push All", desc: "Залить все файлы workspace на облако", cmd: "vscodesync.pushAll" },
      { label: "Pull All", desc: "Скачать все файлы workspace с облака", cmd: "vscodesync.pullAll" },
      { label: "Push текущего файла", desc: "Залить открытый файл", cmd: "vscodesync.pushCurrentFile" },
      { label: "Pull текущего файла", desc: "Скачать открытый файл с облака", cmd: "vscodesync.pullCurrentFile" },
      { label: "Diff с облаком", desc: "Сравнить локальный файл с облачной версией", cmd: "vscodesync.diffWithCloud" },
      { label: "Расхождения", desc: "Панель: что разошлось с облаком, отправка и скачивание по выбору", cmd: "vscodesync.openDivergences" },
    ],
  },
  {
    title: "Файлы",
    icon: "📄",
    items: [
      { label: "Добавить файл или папку", desc: "Добавить в workspace (рекурсивно из папки)", cmd: "vscodesync.addCurrentFile", style: "primary" },
      { label: "В новый воркспейс", desc: "Создать воркспейс в облаке и добавить выбранное", cmd: "vscodesync.addToNewWorkspace" },
      { label: "Убрать из синхронизации", desc: "Remove from Sync (с облака)", cmd: "vscodesync.removeFromSync", style: "danger" },
      { label: "Переместить в другой workspace", desc: "Move Current File to Workspace", cmd: "vscodesync.moveCurrentFileToWorkspace" },
      { label: "История файла", desc: "Show File History (версии в облаке)", cmd: "vscodesync.showFileHistory" },
      { label: "Quick Transfer", desc: "Разовая передача файла на другую машину", cmd: "vscodesync.sendQuickTransfer" },
    ],
  },
  {
    title: "Конфликты",
    icon: "⚠",
    items: [
      { label: "Разрешить конфликты", desc: "Keep Mine / Take Theirs / AI Merge", cmd: "vscodesync.resolveConflicts", style: "primary" },
      { label: "Keep Mine", desc: "Принять локальную версию", cmd: "vscodesync.keepMine" },
      { label: "Take Theirs", desc: "Принять облачную версию", cmd: "vscodesync.takeTheirs" },
      { label: "3-Way Diff", desc: "Открыть 3-way diff с общим предком", cmd: "vscodesync.openConflictDiff3way" },
    ],
  },
  {
    title: "Watch Mode",
    icon: "👁",
    items: [
      { label: "Включить Watch Mode", desc: "Фоновый автосинк по таймеру", cmd: "vscodesync.enableWatchMode", style: "primary" },
      { label: "Выключить Watch Mode", desc: "Остановить фоновый мониторинг", cmd: "vscodesync.disableWatchMode" },
      { label: "Пауза синхронизации", desc: "Suspend — временно приостановить", cmd: "vscodesync.togglePause" },
      { label: "Возобновить синхронизацию", desc: "Resume после паузы", cmd: "vscodesync.resume" },
    ],
  },
  {
    title: "Снапшоты и история",
    icon: "📸",
    items: [
      { label: "Создать снапшот", desc: "Create Snapshot — точка восстановления workspace", cmd: "vscodesync.createSnapshot", style: "primary" },
      { label: "Restore Snapshot", desc: "Восстановить workspace из снапшота", cmd: "vscodesync.restoreSnapshot" },
      { label: "Diff Snapshots", desc: "Сравнить два снапшота между собой", cmd: "vscodesync.diffSnapshots" },
    ],
  },
  {
    title: "Статистика и мониторинг",
    icon: "📊",
    items: [
      { label: "Activity Feed", desc: "Лог событий синхронизации", cmd: "vscodesync.openActivityFeed", style: "primary" },
      { label: "Stats Dashboard", desc: "Статистика трафика, push/pull за месяц", cmd: "vscodesync.openStats" },
      { label: "Health Check", desc: "Проверить состояние workspace и токенов", cmd: "vscodesync.healthCheck" },
      { label: "Repair State", desc: "Восстановить локальный кэш с облака", cmd: "vscodesync.repairState" },
    ],
  },
  {
    title: "Шифрование",
    icon: "🔒",
    items: [
      { label: "Импортировать ключ шифрования", desc: "Импорт ключа AES-256 с другой машины", cmd: "vscodesync.importEncryptionKey" },
      { label: "Экспортировать ключ", desc: "Сохранить ключ с паролем", cmd: "vscodesync.exportEncryptionKey" },
      { label: "Импортировать ключ", desc: "Загрузить ключ из файла", cmd: "vscodesync.importEncryptionKey" },
      { label: "Сменить ключ", desc: "Rotate Encryption Key", cmd: "vscodesync.rotateEncryptionKey" },
    ],
  },
  {
    title: "Настройки",
    icon: "⚙",
    items: [
      { label: "Открыть настройки", desc: "Все параметры VSCodeSync", cmd: "vscodesync.openSyncSettings", style: "primary" },
      { label: "Уведомления", desc: "Set Notification Level (minimal/normal/verbose)", cmd: "vscodesync.setNotificationLevel" },
      { label: "Телеметрия вкл/выкл", desc: "Toggle Telemetry", cmd: "vscodesync.toggleTelemetry" },
      { label: "Уровень уведомлений", desc: "Minimal / Normal / Verbose", cmd: "vscodesync.setNotificationLevel" },
    ],
  },
];

function getCommandCenterHtml(): string {
  const groupsHtml = GROUPS.map((g) => {
    const items = g.items.map((item) => {
      const cls = item.style === "danger" ? "btn-danger" : item.style === "primary" ? "btn-primary" : "btn-secondary";
      return `<div class="cmd-item">
        <div class="cmd-info">
          <strong>${item.label}</strong>
          <span class="cmd-desc">${item.desc}</span>
        </div>
        <button class="${cls}" onclick="run('${item.cmd}')">${item.label}</button>
      </div>`;
    }).join("\n");

    return `<details open>
      <summary><span class="group-icon">${g.icon}</span> ${g.title}</summary>
      <div class="group-body">${items}</div>
    </details>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VSCodeSync Command Center</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 28px;
    max-width: 900px;
    margin: 0 auto;
  }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  p.sub { color: var(--vscode-descriptionForeground); margin-top: 0; margin-bottom: 20px; }
  details {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    margin-bottom: 12px;
    overflow: hidden;
  }
  summary {
    padding: 10px 14px;
    cursor: pointer;
    font-weight: 600;
    background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "▶"; font-size: 0.7em; transition: transform 0.15s; }
  details[open] summary::before { transform: rotate(90deg); }
  .group-icon { font-size: 1.1em; }
  .group-body { padding: 4px 8px 8px; }
  .cmd-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 8px;
    border-radius: 4px;
    gap: 12px;
  }
  .cmd-item:hover { background: var(--vscode-list-hoverBackground); }
  .cmd-info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .cmd-info strong { font-size: 0.95em; }
  .cmd-desc { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-top: 1px; }
  button {
    border: none;
    border-radius: 4px;
    padding: 5px 14px;
    font-size: 0.85em;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-danger {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f48771);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #f48771);
  }
  .btn-danger:hover { opacity: 0.85; }
  .search-box {
    width: 100%;
    padding: 7px 12px;
    margin-bottom: 16px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 0.95em;
  }
  .search-box::placeholder { color: var(--vscode-input-placeholderForeground); }
  .hidden { display: none !important; }
</style>
</head>
<body>
<h1>🎛 VSCodeSync — Command Center</h1>
<p class="sub">Нажми кнопку чтобы выполнить команду. Правая кнопка мыши на workspace/файл в панели тоже показывает контекстное меню.</p>

<input class="search-box" type="text" placeholder="🔍 Поиск команды..." oninput="search(this.value)">

<div id="groups">
${groupsHtml}
</div>

<script>
  const vscode = acquireVsCodeApi();

  function run(cmd) {
    vscode.postMessage({ command: cmd });
  }

  function search(q) {
    q = q.toLowerCase().trim();
    document.querySelectorAll('details').forEach(det => {
      let anyVisible = false;
      det.querySelectorAll('.cmd-item').forEach(item => {
        const text = item.textContent.toLowerCase();
        if (!q || text.includes(q)) {
          item.classList.remove('hidden');
          anyVisible = true;
        } else {
          item.classList.add('hidden');
        }
      });
      det.classList.toggle('hidden', !anyVisible);
      if (q) det.open = true;
    });
  }
</script>
</body>
</html>`;
}
