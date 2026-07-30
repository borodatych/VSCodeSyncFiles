/**
 * VSCodeSync Settings Panel — красивый webview для всех настроек расширения.
 * Настройки разбиты по разделам; изменения применяются сразу через VS Code API.
 */
import * as vscode from "vscode";
import { EXTENSION_SETTINGS_QUERY } from "../core/extensionIdentity.js";
import { GlobalConfigManager } from "../core/globalConfigManager.js";

const CFG = "vscodesync";

export function registerSettingsPanel(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.showSettingsPanel", () => {
      const panel = vscode.window.createWebviewPanel(
        "vscodesyncSettings",
        "VSCodeSync: Настройки",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );

      const sendSettings = (): void => {
        const cfg = vscode.workspace.getConfiguration(CFG);
        const values: Record<string, unknown> = {};
        for (const key of ALL_KEYS) {
          values[key] = cfg.get(key);
        }
        void panel.webview.postMessage({ type: "init", values });
      };

      const hasToken = (raw: string | undefined | null): boolean => {
        if (!raw) return false;
        try { return !!(JSON.parse(raw) as { accessToken?: string }).accessToken; } catch { return false; }
      };

      const sendAuthStatus = async (): Promise<void> => {
        try {
          const [onedriveRaw, gdriveRaw, yandexRaw, dropboxRaw] = await Promise.all([
            context.secrets.get("vscodesync.onedrive.oauth"),
            context.secrets.get("vscodesync.gdrive.oauth"),
            context.secrets.get("vscodesync.yandex.oauth"),
            context.secrets.get("vscodesync.dropbox.oauth"),
          ]);
          let activeProvider: string | null = null;
          try {
            const gcm = new GlobalConfigManager(GlobalConfigManager.resolveDefaultConfigDir(), undefined);
            const gc = await gcm.load();
            activeProvider = gc.activeProvider ?? null;
          } catch { /* ignore */ }
          void panel.webview.postMessage({
            type: "authStatus",
            onedrive: hasToken(onedriveRaw),
            gdrive: hasToken(gdriveRaw),
            yandex: hasToken(yandexRaw),
            dropbox: hasToken(dropboxRaw),
            activeProvider,
          });
        } catch { /* ignore */ }
      };

      panel.webview.html = getSettingsHtml();
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          sendSettings();
          void sendAuthStatus();
        }
      });

      // Handle changes from webview
      panel.webview.onDidReceiveMessage(
        async (msg: { type: string; key?: string; value?: unknown }) => {
          if (msg.type === "update" && msg.key !== undefined) {
            const cfg = vscode.workspace.getConfiguration(CFG);
            await cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
          }
          if (msg.type === "openNative") {
            await vscode.commands.executeCommand(
              "workbench.action.openSettings",
              EXTENSION_SETTINGS_QUERY,
            );
          }
          if (msg.type === "runCommand" && msg.key) {
            await vscode.commands.executeCommand(msg.key);
            // Refresh auth status after auth commands
            void sendAuthStatus();
          }
          if (msg.type === "ready") {
            sendSettings();
            void sendAuthStatus();
          }
          if (msg.type === "refreshAuth") {
            void sendAuthStatus();
          }
          if (msg.type === "signOut" && msg.key) {
            const providerKey = msg.key;
            const secretKey =
              providerKey === "onedrive" ? "vscodesync.onedrive.oauth" :
              providerKey === "gdrive" ? "vscodesync.gdrive.oauth" :
              providerKey === "yandex" ? "vscodesync.yandex.oauth" :
              providerKey === "dropbox" ? "vscodesync.dropbox.oauth" : null;
            if (secretKey) {
              await context.secrets.delete(secretKey);
              void vscode.window.showInformationMessage(`VSCodeSync: ${providerKey} — токен удалён.`);
              void sendAuthStatus();
            }
          }
        },
        undefined,
        context.subscriptions,
      );

      // Re-send on external settings change
      const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CFG)) {
          sendSettings();
        }
      });
      panel.onDidDispose(() => {
        disposable.dispose();
      });
    }),
  );
}

const ALL_KEYS = [
  "onedriveClientId", "googleDriveClientId", "dropboxAppKey",
  "yandexOAuthClientId", "yandexUseAppFolder",
  "notificationLevel", "showFileDecorations", "digestIntervalMinutes",
  "maxFileSizeMB", "warnOnBinaryFiles", "showPreview", "syncSummaryOnStartup",
  "lineEnding",
  "localBackupEnabled", "localBackupRetentionDays",
  "syncOnOpen", "syncOnFocusDelayMs", "pushOnCommit",
  "smartSuggestions", "requireMachineApproval",
  "pauseOnMeteredConnection", "pauseBatteryThreshold",
  "watchMode", "watchIntervalSeconds", "watchMaxIntervalSeconds", "watchAdaptive",
  "compressUploads", "encryption", "aiMerge.enabled",
  "deltaSync", "deltaThresholdKB",
  "webhooks.enabled", "webhooks.url", "webhooks.fallbackAfterMinutes", "webhooks.tunnelEnabled",
  "gitBranchAutoSync",
  "snapshotRetentionDays", "maxSnapshotsPerWorkspace",
  "activityRetentionDays", "monthlyBandwidthLimitMB",
  "workspaceInactiveDays", "batchAddWarnThreshold", "longAbsenceThresholdDays",
  "quickTransferTtlDays",
  "telemetry", "telemetryIngestUrl",
  // v0.7 — performance / auto-sync mode tunables.
  "autoSyncMode",
  "sync.concurrency", "sync.workspaceConcurrency",
  "verifyUploadHash", "historyVersions", "historyMode", "historyLazyDrainMinutes",
  "metaWriteRetries", "verifyRetries", "softLockStaleHours",
  "tokenRefreshSkewMinutes", "saveDebounceSecDefault",
  "watchIdleCyclesBeforeBackoff", "localBackupDir",
  "gdrive.folderCacheTtlSec",
  "onedrive.uploadSessionThresholdMB", "onedrive.uploadChunkMB",
  "yandex.apiTimeoutMs", "yandex.dataTimeoutMs", "yandex.lockedRetryDelayMs",
  "diagnostics.profileSync",
];

function getSettingsHtml(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VSCodeSync Settings</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:var(--vscode-font-family);
    font-size:var(--vscode-font-size);
    color:var(--vscode-foreground);
    background:var(--vscode-editor-background);
    display:flex; height:100vh; overflow:hidden;
  }
  /* Sidebar */
  .sidebar{
    width:200px; flex-shrink:0;
    background:var(--vscode-sideBar-background);
    border-right:1px solid var(--vscode-panel-border);
    overflow-y:auto; padding:12px 0;
  }
  .sidebar-item{
    padding:8px 16px; cursor:pointer;
    font-size:0.9em; border-left:3px solid transparent;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  .sidebar-item:hover{background:var(--vscode-list-hoverBackground)}
  .sidebar-item.active{
    border-left-color:var(--vscode-focusBorder);
    background:var(--vscode-list-activeSelectionBackground);
    color:var(--vscode-list-activeSelectionForeground);
  }
  /* Main content */
  .content{flex:1; overflow-y:auto; padding:24px 32px; max-width:720px}
  .section{display:none}
  .section.active{display:block}
  h2{font-size:1.2em; margin-bottom:20px; padding-bottom:8px;
     border-bottom:1px solid var(--vscode-panel-border)}
  /* Setting row */
  .setting{
    display:flex; align-items:flex-start; justify-content:space-between;
    gap:16px; padding:12px 0; border-bottom:1px solid var(--vscode-panel-border);
  }
  .setting:last-child{border-bottom:none}
  .setting-info{flex:1; min-width:0}
  .setting-label{font-weight:500; font-size:0.95em; margin-bottom:3px}
  .setting-desc{font-size:0.8em; color:var(--vscode-descriptionForeground); line-height:1.4}
  .setting-key{font-size:0.72em; color:var(--vscode-textPreformat-foreground);
               font-family:var(--vscode-editor-font-family,monospace); margin-top:3px}
  .setting-control{flex-shrink:0; min-width:140px; display:flex; justify-content:flex-end}
  /* Controls */
  input[type=text], input[type=number], select{
    background:var(--vscode-input-background);
    color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-panel-border);
    border-radius:3px; padding:5px 9px; font-size:0.9em;
    width:190px;
  }
  input[type=text]:focus, input[type=number]:focus, select:focus{
    outline:none;
    border-color:var(--vscode-panel-border);
  }
  /* Toggle switch */
  .toggle{position:relative; display:inline-block; width:40px; height:22px}
  .toggle input{opacity:0; width:0; height:0}
  .slider{
    position:absolute; cursor:pointer; inset:0;
    background:var(--vscode-button-secondaryBackground);
    border-radius:22px; transition:.2s;
  }
  .slider:before{
    position:absolute; content:""; height:16px; width:16px;
    left:3px; bottom:3px;
    background:var(--vscode-button-secondaryForeground);
    border-radius:50%; transition:.2s;
  }
  input:checked + .slider{background:var(--vscode-button-background)}
  input:checked + .slider:before{
    transform:translateX(18px);
    background:var(--vscode-button-foreground);
  }
  /* Buttons */
  .btn{
    border:none; border-radius:3px; padding:5px 12px;
    font-size:0.85em; cursor:pointer; margin-top:4px;
  }
  .btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  .saved{color:var(--vscode-testing-iconPassed,#89d185);font-size:0.8em;margin-left:6px;opacity:0;transition:opacity .3s}
  .saved.show{opacity:1}
  /* Search */
  /* Provider cards */
  .provider-card{
    border:1px solid var(--vscode-panel-border);
    border-radius:6px; margin-bottom:12px; overflow:hidden;
  }
  .provider-header{
    display:flex; align-items:center; gap:8px; flex-wrap:wrap;
    padding:10px 14px;
    background:var(--vscode-sideBarSectionHeader-background,var(--vscode-editor-background));
    border-bottom:1px solid var(--vscode-panel-border);
  }
  .provider-header .setting{ border:none; padding:8px 14px }
  .provider-header .setting:last-child{ border:none }
  .provider-card .setting{ padding:10px 14px }
  .provider-card .setting:last-child{ border-bottom:none }
  .provider-name{ font-weight:600; font-size:0.95em; flex:1 }
  .badge{
    font-size:0.75em; padding:2px 8px; border-radius:10px; font-weight:500;
  }
  .badge-ok{ background:#1a3a1a; color:#89d185; border:1px solid #3a6a3a }
  .badge-no{ background:#3a1a1a; color:#f48771; border:1px solid #6a3a3a }
  .badge-unknown{ background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); border:1px solid var(--vscode-panel-border) }
  .badge-active{ background:#1a3a2a; color:#4caf82; border:1px solid #2a6a4a }
  .btn-sm{ padding:3px 10px; font-size:0.8em }
  .help-btn{
    background:none; border:1px solid var(--vscode-panel-border);
    border-radius:50%; width:18px; height:18px; font-size:0.75em;
    cursor:pointer; color:var(--vscode-descriptionForeground);
    display:inline-flex; align-items:center; justify-content:center;
    flex-shrink:0; margin-left:4px; vertical-align:middle;
  }
  .help-btn:hover{ border-color:var(--vscode-focusBorder); color:var(--vscode-foreground); }
  #help-modal{ display:none }
  #help-modal.open{ display:flex!important }
  #help-modal-box h3{ font-size:1.1em; margin-bottom:12px }
  #help-modal-box ol{ padding-left:20px; line-height:2.2 }
  #help-modal-box code{ background:var(--vscode-textCodeBlock-background); padding:1px 5px; border-radius:3px; font-size:0.88em }
  #help-modal-box a{ color:var(--vscode-textLink-foreground) }
  #help-modal-box .step-note{ font-size:0.82em; color:var(--vscode-descriptionForeground); margin-top:8px; line-height:1.5 }
  .btn-danger-sm{
    background:transparent; color:var(--vscode-errorForeground,#f48771);
    border:1px solid var(--vscode-panel-border);
    border-radius:3px; padding:3px 10px; font-size:0.8em; cursor:pointer;
  }
  .search-bar{
    display:flex; gap:8px; margin-bottom:24px; align-items:center;
    padding-bottom:12px; border-bottom:1px solid var(--vscode-panel-border);
  }
  .search-input{
    flex:1; background:var(--vscode-input-background);
    color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border);
    border-radius:3px; padding:5px 10px; font-size:0.9em;
  }
  .top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
  h1{font-size:1.3em}
</style>
</head>
<body>

<nav class="sidebar">
  <div class="sidebar-item active" onclick="nav('providers',this)">🔑 Провайдеры</div>
  <div class="sidebar-item" onclick="nav('sync',this)">☁ Синхронизация</div>
  <div class="sidebar-item" onclick="nav('performance',this)">🚀 Производительность</div>
  <div class="sidebar-item" onclick="nav('notifications',this)">🔔 Уведомления</div>
  <div class="sidebar-item" onclick="nav('watchmode',this)">👁 Watch Mode</div>
  <div class="sidebar-item" onclick="nav('reliability',this)">🛡 Надёжность</div>
  <div class="sidebar-item" onclick="nav('security',this)">🔒 Безопасность</div>
  <div class="sidebar-item" onclick="nav('snapshots',this)">📸 Снапшоты</div>
  <div class="sidebar-item" onclick="nav('advanced',this)">⚙ Расширенные</div>
  <div class="sidebar-item" onclick="nav('telemetry',this)">📊 Телеметрия</div>
</nav>

<div class="content">
  <div class="top-bar">
    <h1>⚙ Настройки VSCodeSync</h1>
    <button class="btn btn-secondary" onclick="openNative()">Открыть в редакторе настроек</button>
  </div>
  <div class="search-bar">
    <input class="search-input" type="text" placeholder="🔍 Поиск..." oninput="search(this.value)">
    <span id="saved-global" class="saved">✓ Сохранено</span>
  </div>

  <!-- ── ПРОВАЙДЕРЫ ──────────────────────────────────────────── -->
  <div id="providers" class="section active">
    <h2>🔑 Провайдеры</h2>

    <div class="provider-card">
      <div class="provider-header">
        <span class="provider-name">☁ OneDrive</span>
        <span id="status_onedrive" class="badge badge-unknown">…</span>
        <button id="signin_onedrive" class="btn btn-secondary btn-sm" style="display:none" onclick="signIn('vscodesync.onedriveSignIn','onedrive')">Войти</button>
        <button id="signout_onedrive" class="btn btn-danger-sm" style="display:none" onclick="signOut('','onedrive')">Выйти</button>
      </div>
      ${textWithHelp("onedriveClientId","Client ID","Azure AD Application (client) ID.","onedrive")}
    </div>

    <div class="provider-card">
      <div class="provider-header">
        <span class="provider-name">🟡 Яндекс Диск</span>
        <span id="status_yandex" class="badge badge-unknown">…</span>
        <button id="signin_yandex" class="btn btn-secondary btn-sm" style="display:none" onclick="signIn('vscodesync.yandexDiskSignIn','yandex')">Войти</button>
        <button id="signin_yandex_token" class="btn btn-secondary btn-sm" style="display:none" onclick="signIn('vscodesync.yandexDiskEnterToken','yandex')">Токен вручную</button>
        <button id="signout_yandex" class="btn btn-danger-sm" style="display:none" onclick="signOut('','yandex')">Выйти</button>
      </div>
      ${textWithHelp("yandexOAuthClientId","Client ID","ClientID из oauth.yandex.ru.","yandex")}
      ${toggle("yandexUseAppFolder","Папка приложения","Файлы в «Приложения/{app}/» (scope: disk.app_folder). При смене требуется повторный вход.")}
    </div>

    <div class="provider-card">
      <div class="provider-header">
        <span class="provider-name">🔵 Google Drive</span>
        <span id="status_gdrive" class="badge badge-unknown">…</span>
        <button id="signin_gdrive" class="btn btn-secondary btn-sm" style="display:none" onclick="signIn('vscodesync.googleDriveSignIn','gdrive')">Войти</button>
        <button id="signout_gdrive" class="btn btn-danger-sm" style="display:none" onclick="signOut('','gdrive')">Выйти</button>
      </div>
      ${textWithHelp("googleDriveClientId","Client ID","OAuth 2.0 Client ID из Google Cloud Console.","gdrive")}
    </div>

    <div class="provider-card">
      <div class="provider-header">
        <span class="provider-name">📦 Dropbox</span>
        <span id="status_dropbox" class="badge badge-unknown">…</span>
        <button id="signin_dropbox" class="btn btn-secondary btn-sm" style="display:none" onclick="signIn('vscodesync.dropboxSignIn','dropbox')">Войти</button>
        <button id="signout_dropbox" class="btn btn-danger-sm" style="display:none" onclick="signOut('','dropbox')">Выйти</button>
      </div>
      ${textWithHelp("dropboxAppKey","App Key","App key из dropbox.com/developers.","dropbox")}
    </div>

    <!-- Help Modal -->
    <div id="help-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;align-items:center;justify-content:center">
      <div id="help-modal-box" style="background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:24px 28px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto;position:relative">
        <button onclick="closeHelp()" style="position:absolute;top:12px;right:14px;background:none;border:none;font-size:1.2em;cursor:pointer;color:var(--vscode-foreground)">✕</button>
        <div id="help-modal-content"></div>
      </div>
    </div>

    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="runCmd('vscodesync.showProviderSetupGuide')">📖 Инструкции по настройке</button>
      <button class="btn btn-secondary" onclick="runCmd('vscodesync.setActiveProvider')">Сменить активный провайдер</button>
    </div>
  </div>

  <!-- ── СИНХРОНИЗАЦИЯ ───────────────────────────────────────── -->
  <div id="sync" class="section">
    <h2>☁ Синхронизация</h2>
    ${select("lineEnding","Окончания строк","Нормализация при хэше: lf (рекомендуется), crlf, preserve (без нормализации).",["lf","crlf","preserve"])}
    ${number("maxFileSizeMB","Макс. размер файла (МБ)","0 — без лимита. Файлы больше лимита не синхронизируются.",0,1000)}
    ${toggle("showPreview","Предпросмотр перед sync","Показывать план синхронизации перед Push/Pull/Sync из панели.")}
    ${toggle("syncSummaryOnStartup","Pull при старте VS Code","Тихий Pull при запуске и сводка изменений.")}
    ${toggle("syncOnOpen","Pull при открытии файла","Тихий conditional GET при открытии отслеживаемого файла.")}
    ${number("syncOnFocusDelayMs","Задержка sync при фокусе (мс)","Sync через N мс после получения фокуса окном VS Code.",0,60000)}
    ${toggle("pushOnCommit","Push при Git коммите","Автоматически пушить отслеживаемые файлы после git commit.")}
    ${toggle("gitBranchAutoSync","Git branch auto-sync","Suspend/Resume workspace при смене git-ветки.")}
    ${toggle("warnOnBinaryFiles","Предупреждать о бинарных файлах","Спрашивать подтверждение перед добавлением бинарного файла.")}
    ${toggle("smartSuggestions","Умные подсказки","Предлагать группировку часто редактируемых файлов в workspace.")}
    ${number("workspaceInactiveDays","Дней до архивирования","Предлагать архивировать workspace если нет активности (0 — не проверять).",0,3650)}
    ${number("batchAddWarnThreshold","Порог пакетного добавления","Предупреждать при добавлении больше N файлов за раз.",1,10000)}
    ${number("longAbsenceThresholdDays","Порог «долгого отсутствия» (дни)","Показывать подсказку о накопившихся изменениях после N дней.",1,365)}
  </div>

  <!-- ── ПРОИЗВОДИТЕЛЬНОСТЬ ──────────────────────────────────── -->
  <div id="performance" class="section">
    <h2>🚀 Производительность и авто-режим</h2>

    ${select("autoSyncMode","Режим автосинхронизации","Что делают автоматические триггеры (save / open / focus / watch / commit). off — ничего, check-only — только статусы, full — историческое поведение.",["off","check-only","full"])}
    ${number("sync.concurrency","Параллелизм файлов","Сколько файлов синхронизировать параллельно в одном workspace. 1 = последовательно (старое).",1,32)}
    ${number("sync.workspaceConcurrency","Параллелизм workspace'ов","Сколько workspace'ов синкать параллельно при pushAll. Учитывайте rate-limit провайдера.",1,16)}
    ${select("verifyUploadHash","Проверка хэша после upload","plaintext-only — проверять только для незашифрованных файлов (старое). never — не проверять, экономия 1 GET на push.",["plaintext-only","never"])}
    ${select("historyMode","Режим истории файлов","inline — сохранять снимок на каждый push (+1 GET +1 PUT). lazy — отгружать пакетом. off — без истории.",["inline","lazy","off"])}
    ${number("historyVersions","Версий в .history/","Сколько версий каждого файла держать в облаке. 0 — без ротации.",0,200)}
    ${number("historyLazyDrainMinutes","Период отлива истории (мин)","Только для historyMode=lazy: как часто отгружать накопленные снимки.",1,720)}
    ${number("metaWriteRetries","Retry для _meta.json","Сколько раз пытаться записать meta при гонке с другой машиной.",1,10)}
    ${number("verifyRetries","Retry для verify-hash","Сколько раз перепроверять хэш blob'а после upload.",1,10)}
    ${number("softLockStaleHours","Soft-lock TTL (часы)","Через сколько часов editingSince считается устаревшим.",1,168)}
    ${number("tokenRefreshSkewMinutes","Обновление токена за (мин)","За сколько минут до истечения обновлять OAuth-токен.",1,60)}
    ${number("saveDebounceSecDefault","Save-debounce по умолчанию (сек)","Дефолтная задержка push после save (если workspace не задал свою).",0,300)}
    ${number("watchIdleCyclesBeforeBackoff","Циклов watch до backoff","Сколько пустых watch-циклов ждать до удвоения интервала.",1,100)}
    ${text("localBackupDir","Папка локальных бэкапов","Относительно корня workspace. Дефолт: .vscode/vscodesync-local-backup")}
    ${number("gdrive.folderCacheTtlSec","TTL кэша Google Drive folder-id (сек)","Кэш ускоряет деревообход путей. 0 = отключить.",0,86400)}
    ${number("onedrive.uploadSessionThresholdMB","OneDrive: порог session upload (МБ)","Выше — multipart session.",1,250)}
    ${number("onedrive.uploadChunkMB","OneDrive: размер chunk (МБ)","Кратно 320 КБ; 4–8 на быстром канале.",0.32,60)}
    ${number("yandex.apiTimeoutMs","Yandex: API таймаут (мс)","Метаданные / auth.",5000,300000)}
    ${number("yandex.dataTimeoutMs","Yandex: data таймаут (мс)","Upload PUT / download GET.",10000,600000)}
    ${number("yandex.lockedRetryDelayMs","Yandex: 423 retry (мс)","Пауза перед повтором при HTTP 423.",100,30000)}
    ${toggle("diagnostics.profileSync","Профилировать sync","Собирать тайминги push/pull для команды «VSCodeSync: Профиль синка». Минимальный оверхед.")}

    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="runCmd('vscodesync.cycleAutoSyncMode')">🚦 Сменить авто-режим</button>
      <button class="btn btn-secondary" onclick="runCmd('vscodesync.profileSync')">📊 Открыть профиль синка</button>
    </div>
  </div>

  <!-- ── УВЕДОМЛЕНИЯ ─────────────────────────────────────────── -->
  <div id="notifications" class="section">
    <h2>🔔 Уведомления</h2>
    ${select("notificationLevel","Уровень уведомлений","minimal — только конфликты и ошибки. normal — + сводки. verbose — всё.",["minimal","normal","verbose"])}
    ${toggle("showFileDecorations","Значки в проводнике","Показывать иконки статуса синхронизации на файлах.")}
    ${number("digestIntervalMinutes","Интервал дайджеста (мин)","Группировать уведомления за этот период. 0 — мгновенно.",5,1440)}
    ${number("activityRetentionDays","Хранить Activity Feed (дней)","Как долго хранить лог событий синхронизации.",1,3650)}
    ${number("quickTransferTtlDays","TTL Quick Transfer (дни)","Сколько дней разовая передача хранится в облаке.",1,365)}
    ${number("monthlyBandwidthLimitMB","Лимит трафика/мес (МБ)","0 — без лимита. При превышении — предупреждение.",0,100000)}
  </div>

  <!-- ── WATCH MODE ──────────────────────────────────────────── -->
  <div id="watchmode" class="section">
    <h2>👁 Watch Mode</h2>
    ${toggle("watchMode","Включить Watch Mode","Фоновый периодический sync всех активных workspace.")}
    ${number("watchIntervalSeconds","Интервал опроса (сек)","Базовый интервал проверки изменений. Минимум 5 сек.",5,3600)}
    ${number("watchMaxIntervalSeconds","Макс. интервал backoff (сек)","При отсутствии изменений интервал растёт до этого значения.",30,86400)}
    ${toggle("watchAdaptive","Адаптивный интервал","При обнаружении изменений сбросить интервал к минимуму.")}
    ${toggle("webhooks.enabled","Webhooks (push вместо polling)","Получать уведомления от OneDrive/GDrive вместо опроса по таймеру.")}
    ${text("webhooks.url","Webhook URL","Публичный HTTPS URL для получения push-уведомлений от провайдера.")}
    ${number("webhooks.fallbackAfterMinutes","Fallback после тишины (мин)","Переходить в polling если нет push-уведомлений N минут. 0 — не возвращаться.",0,1440)}
    ${toggle("webhooks.tunnelEnabled","smee.io туннель","Автоматически создать публичный tunnel для webhooks (без белого IP).")}
  </div>

  <!-- ── НАДЁЖНОСТЬ ──────────────────────────────────────────── -->
  <div id="reliability" class="section">
    <h2>🛡 Надёжность</h2>
    ${toggle("localBackupEnabled","Локальный бэкап","Сохранять копию файла в .vscode/vscodesync-local-backup/ перед Pull.")}
    ${number("localBackupRetentionDays","Хранить бэкапы (дни)","Удалять локальные бэкапы старше N дней. 0 — не удалять.",0,365)}
    ${toggle("requireMachineApproval","Одобрение новых машин","Новые машины получают статус «pending» до подтверждения.")}
    ${toggle("pauseOnMeteredConnection","Пауза на лимитном соединении","Автоматически приостанавливать sync на мобильном/лимитном интернете.")}
    ${number("pauseBatteryThreshold","Пауза при заряде < % (0 — выкл)","Приостанавливать sync при низком заряде батареи.",0,100)}
  </div>

  <!-- ── БЕЗОПАСНОСТЬ ────────────────────────────────────────── -->
  <div id="security" class="section">
    <h2>🔒 Безопасность</h2>
    ${toggle("encryption","E2E шифрование (AES-256-GCM)","Шифровать файлы перед загрузкой на облако. Требует настройки ключа. Несовместимо с compression.")}
    ${toggle("aiMerge.enabled","AI Merge конфликтов","Кнопка «✨ Merge with AI» в диалоге конфликтов. Требует GitHub Copilot.")}
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-secondary" onclick="runCmd('vscodesync.setupEncryptionKey')">Настроить ключ шифрования</button>
      <button class="btn btn-secondary" onclick="runCmd('vscodesync.exportEncryptionKey')">Экспортировать ключ</button>
      <button class="btn btn-secondary" onclick="runCmd('vscodesync.importEncryptionKey')">Импортировать ключ</button>
      <button class="btn btn-secondary" onclick="runCmd('vscodesync.rotateEncryptionKey')">Сменить ключ</button>
    </div>
  </div>

  <!-- ── СНАПШОТЫ ────────────────────────────────────────────── -->
  <div id="snapshots" class="section">
    <h2>📸 Снапшоты и история</h2>
    ${number("snapshotRetentionDays","TTL снапшотов (дни)","Автоматически удалять снапшоты старше N дней.",1,3650)}
    ${number("maxSnapshotsPerWorkspace","Макс. снапшотов на workspace","Старые удаляются при создании нового сверх лимита.",1,1000)}
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="runCmd('vscodesync.createSnapshot')">📸 Создать снапшот</button>
      <button class="btn btn-secondary" onclick="runCmd('vscodesync.restoreSnapshot')">Восстановить снапшот</button>
    </div>
  </div>

  <!-- ── РАСШИРЕННЫЕ ─────────────────────────────────────────── -->
  <div id="advanced" class="section">
    <h2>⚙ Расширенные</h2>
    ${toggle("compressUploads","Gzip сжатие загрузок","Сжимать текстовые файлы перед загрузкой. Несовместимо с шифрованием.")}
    ${toggle("deltaSync","Delta Sync (экспериментально)","Загружать только изменённые части файлов (rolling-hash CDC).")}
    ${number("deltaThresholdKB","Порог delta sync (КБ)","Delta sync применяется только для файлов крупнее N КБ.",1,102400)}
  </div>

  <!-- ── ТЕЛЕМЕТРИЯ ──────────────────────────────────────────── -->
  <div id="telemetry" class="section">
    <h2>📊 Телеметрия</h2>
    ${toggle("telemetry","Отправлять телеметрию","Только агрегаты: провайдер, число workspace, версия. Пути и файлы — никогда.")}
    ${text("telemetryIngestUrl","Ingest URL (опционально)","POST JSON на этот URL. Пусто — только VS Code Telemetry API.")}
    <div style="margin-top:16px">
      <button class="btn btn-secondary" onclick="runCmd('vscodesync.toggleTelemetry')">Переключить телеметрию</button>
    </div>
  </div>
</div><!-- /content -->

<script>
const vscode = acquireVsCodeApi();

// Notify extension that webview is ready
vscode.postMessage({ type: 'ready' });

function nav(id, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
  clearSearch();
}

// Receive settings from extension
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'init') {
    for (const [key, val] of Object.entries(msg.values)) {
      const el = document.getElementById('s_' + key.replace(/\\./g,'__'));
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(val);
      else el.value = val != null ? String(val) : '';
    }
  }
  if (msg.type === 'authStatus') {
    setBadge('onedrive', msg.onedrive, msg.activeProvider === 'onedrive');
    setBadge('yandex',   msg.yandex,   msg.activeProvider === 'yandex');
    setBadge('gdrive',   msg.gdrive,   msg.activeProvider === 'gdrive');
    setBadge('dropbox',  msg.dropbox,  msg.activeProvider === 'dropbox');
  }
});

function setBadge(provider, connected, active) {
  const badge = document.getElementById('status_' + provider);
  if (badge) {
    if (active && connected) {
      badge.className = 'badge badge-active';
      badge.textContent = '✓ Активный';
    } else if (connected) {
      badge.className = 'badge badge-ok';
      badge.textContent = '✓ Подключён';
    } else {
      badge.className = 'badge badge-no';
      badge.textContent = '✗ Не авторизован';
    }
  }
  // Show/hide buttons based on connected state
  const showEl = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  };
  if (provider === 'yandex') {
    showEl('signin_yandex', !connected);
    showEl('signin_yandex_token', !connected);
    showEl('signout_yandex', connected);
  } else {
    showEl('signin_' + provider, !connected);
    showEl('signout_' + provider, connected);
  }
}

function signIn(cmd, provider) {
  runCmd(cmd);
  // Poll auth status after a short delay for the flow to complete
  setTimeout(() => vscode.postMessage({ type: 'refreshAuth' }), 3000);
  setTimeout(() => vscode.postMessage({ type: 'refreshAuth' }), 8000);
}

const HELP_CONTENT = {
  onedrive: \`<h3>☁ Как получить OneDrive Client ID</h3>
<ol>
  <li>Открой <a href="https://portal.azure.com">portal.azure.com</a></li>
  <li><b>Microsoft Entra ID → App registrations → New registration</b></li>
  <li>Name: любое — например <code>MyOneDriveSync</code></li>
  <li>Supported accounts: <b>Personal Microsoft accounts (включая Xbox)</b></li>
  <li>Redirect URI: оставь пустым (Device Code не требует)</li>
  <li>После создания: <b>Authentication → Allow public client flows → Yes → Save</b></li>
  <li>Для PKCE добавь Redirect URI: <code>http://127.0.0.1:8736/oauth-callback</code></li>
  <li>Скопируй <b>Application (client) ID</b> → вставь в поле выше</li>
</ol>
<p class="step-note">💡 Выбирай «Personal Microsoft accounts» — это обязательно для личного OneDrive.</p>\`,

  yandex: \`<h3>🟡 Как получить Яндекс Диск Client ID</h3>
<ol>
  <li>Открой <a href="https://oauth.yandex.ru">oauth.yandex.ru</a> → <b>Создать приложение</b></li>
  <li>Тип: <b>«Для авторизации пользователей»</b></li>
  <li>Платформа: <b>Веб-сервисы</b></li>
  <li>Redirect URI: <code>http://127.0.0.1:8735/oauth-callback</code></li>
  <li>Доступы → Дополнительные → добавь: <code>cloud_api:disk.app_folder</code></li>
  <li>Создай приложение → скопируй <b>ClientID</b> → вставь выше</li>
  <li>Включи переключатель <b>«Папка приложения»</b></li>
  <li>Нажми <b>«Токен вручную»</b> (если кнопка «Войти» не работает)</li>
</ol>
<p class="step-note">💡 Если «Войти» выдаёт ошибку scope — используй «Токен вручную»:<br>
Открой <code>https://oauth.yandex.ru/authorize?response_type=token&client_id=ВАШ_ID</code> и скопируй токен из URL.</p>\`,

  gdrive: \`<h3>🔵 Как получить Google Drive Client ID</h3>
<ol>
  <li>Открой <a href="https://console.cloud.google.com">console.cloud.google.com</a></li>
  <li>Создай или выбери проект</li>
  <li><b>APIs & Services → Enable APIs → Google Drive API → Enable</b></li>
  <li><b>APIs & Services → Credentials → Create Credentials → OAuth client ID</b></li>
  <li>Application type: <b>Desktop app</b></li>
  <li>Скопируй <b>Client ID</b> → вставь выше</li>
  <li>OAuth consent screen → добавь свой email в <b>Test users</b></li>
</ol>
<p class="step-note">💡 Google требует добавить себя в Test users пока приложение не верифицировано.</p>\`,

  dropbox: \`<h3>📦 Как получить Dropbox App Key</h3>
<ol>
  <li>Открой <a href="https://www.dropbox.com/developers/apps">dropbox.com/developers/apps</a> → <b>Create app</b></li>
  <li>API: <b>Scoped access</b></li>
  <li>Access type: <b>Full Dropbox</b></li>
  <li>Название: любое — например <code>MyDropboxSync</code></li>
  <li>Settings → OAuth 2 → Redirect URIs → добавь:<br><code>http://127.0.0.1:8734/oauth-callback</code></li>
  <li>Permissions → включи: <code>files.content.write</code>, <code>files.content.read</code>, <code>files.metadata.read</code> → <b>Submit</b></li>
  <li>Скопируй <b>App key</b> → вставь выше</li>
</ol>\`
};

function showHelp(provider) {
  const modal = document.getElementById('help-modal');
  const content = document.getElementById('help-modal-content');
  if (!modal || !content) return;
  content.innerHTML = HELP_CONTENT[provider] || '';
  modal.classList.add('open');
}

function closeHelp() {
  const modal = document.getElementById('help-modal');
  if (modal) modal.classList.remove('open');
}

// Close on backdrop click
document.getElementById('help-modal')?.addEventListener('click', function(e) {
  if (e.target === this) closeHelp();
});

function signOut(_cmd, provider) {
  vscode.postMessage({ type: 'signOut', key: provider });
  setTimeout(() => vscode.postMessage({ type: 'refreshAuth' }), 1000);
}

function update(key, val) {
  vscode.postMessage({ type: 'update', key, value: val });
  const badge = document.getElementById('saved-global');
  if (badge) { badge.classList.add('show'); setTimeout(() => badge.classList.remove('show'), 1500); }
}

function openNative() { vscode.postMessage({ type: 'openNative' }); }
function runCmd(cmd) { vscode.postMessage({ type: 'runCommand', key: cmd }); }

function search(q) {
  q = q.toLowerCase().trim();
  if (!q) { clearSearch(); return; }
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  // Show all sections, hide non-matching rows
  const allSections = document.querySelectorAll('.section');
  allSections.forEach(sec => {
    let any = false;
    sec.querySelectorAll('.setting').forEach(row => {
      const text = row.textContent.toLowerCase();
      if (text.includes(q)) { row.style.display = ''; any = true; }
      else row.style.display = 'none';
    });
    if (any) sec.classList.add('active');
  });
}

function clearSearch() {
  document.querySelectorAll('.setting').forEach(r => r.style.display = '');
}
</script>
</body>
</html>`;
}

// HTML builder helpers
function setting(key: string, label: string, desc: string, control: string): string {
  return `<div class="setting">
    <div class="setting-info">
      <div class="setting-label">${label}</div>
      <div class="setting-desc">${desc}</div>
      <div class="setting-key">vscodesync.${key}</div>
    </div>
    <div class="setting-control">${control}</div>
  </div>`;
}

function toggle(key: string, label: string, desc: string): string {
  const id = `s_${key.replace(/\./g, "__")}`;
  const js = `update('${key}', this.checked)`;
  return setting(key, label, desc,
    `<label class="toggle"><input type="checkbox" id="${id}" onchange="${js}"><span class="slider"></span></label>`);
}

function text(key: string, label: string, desc: string): string {
  const id = `s_${key.replace(/\./g, "__")}`;
  const js = `update('${key}', this.value)`;
  return setting(key, label, desc,
    `<input type="text" id="${id}" onchange="${js}" onblur="${js}">`);
}

function number(key: string, label: string, desc: string, min = 0, max = 99999): string {
  const id = `s_${key.replace(/\./g, "__")}`;
  const js = `update('${key}', Number(this.value))`;
  return setting(key, label, desc,
    `<input type="number" id="${id}" min="${String(min)}" max="${String(max)}" onchange="${js}" onblur="${js}">`);
}

function textWithHelp(key: string, label: string, desc: string, helpProvider: string): string {
  const id = `s_${key.replace(/\./g, "__")}`;
  const js = `update('${key}', this.value)`;
  const control = `<div style="display:flex;align-items:center;gap:4px">
    <input type="text" id="${id}" onchange="${js}" onblur="${js}">
    <button class="help-btn" onclick="showHelp('${helpProvider}')" title="Как получить ID">?</button>
  </div>`;
  return setting(key, label, desc, control);
}

function select(key: string, label: string, desc: string, options: string[]): string {
  const id = `s_${key.replace(/\./g, "__")}`;
  const js = `update('${key}', this.value)`;
  const opts = options.map((o) => `<option value="${o}">${o}</option>`).join("");
  return setting(key, label, desc,
    `<select id="${id}" onchange="${js}">${opts}</select>`);
}
