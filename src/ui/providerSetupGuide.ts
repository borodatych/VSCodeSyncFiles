/**
 * Provider setup guide webview — инструкции по настройке облачных дисков.
 * Открывается командой vscodesync.showProviderSetupGuide.
 */
import * as vscode from "vscode";

export function registerProviderSetupGuide(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.showProviderSetupGuide", () => {
      const panel = vscode.window.createWebviewPanel(
        "vscodesyncSetupGuide",
        "VSCodeSync: Настройка провайдеров",
        vscode.ViewColumn.One,
        { enableScripts: true },
      );
      panel.webview.html = getGuideHtml();
    }),
  );
}

function getGuideHtml(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Настройка провайдеров VSCodeSync</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 24px 32px;
    max-width: 860px;
    margin: 0 auto;
  }
  h1 { font-size: 1.5em; margin-bottom: 8px; }
  h2 { font-size: 1.2em; margin-top: 32px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
  h3 { font-size: 1em; margin-top: 20px; margin-bottom: 6px; }
  .tabs { display: flex; gap: 8px; margin-top: 24px; flex-wrap: wrap; }
  .tab {
    padding: 7px 18px;
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    border-radius: 4px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font-size: 0.95em;
  }
  .tab.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .section { display: none; }
  .section.active { display: block; }
  code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 0.92em;
  }
  pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 12px 16px;
    border-radius: 5px;
    overflow-x: auto;
    font-size: 0.9em;
    line-height: 1.6;
  }
  ol, ul { padding-left: 20px; line-height: 2; }
  .tip {
    background: var(--vscode-inputValidation-infoBackground);
    border-left: 3px solid var(--vscode-inputValidation-infoBorder, #007acc);
    padding: 10px 14px;
    border-radius: 0 4px 4px 0;
    margin: 12px 0;
  }
  .warn {
    background: var(--vscode-inputValidation-warningBackground);
    border-left: 3px solid var(--vscode-inputValidation-warningBorder, #cca700);
    padding: 10px 14px;
    border-radius: 0 4px 4px 0;
    margin: 12px 0;
  }
  a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
<h1>☁ VSCodeSync — Настройка провайдеров</h1>
<p>Выбери провайдер чтобы увидеть пошаговую инструкцию.</p>

<div class="tabs">
  <button class="tab active" onclick="show('yandex', this)">Яндекс Диск</button>
  <button class="tab" onclick="show('onedrive', this)">OneDrive</button>
  <button class="tab" onclick="show('gdrive', this)">Google Drive</button>
  <button class="tab" onclick="show('dropbox', this)">Dropbox</button>
</div>

<!-- ══ ЯНДЕКС ДИСК ══════════════════════════════════════════════════════════ -->
<div id="yandex" class="section active">
  <h2>Яндекс Диск</h2>

  <div class="tip">
    Встроенный Client ID уже настроен — можно сразу перейти к <strong>Шагу 3</strong> и войти без регистрации своего приложения.
    Шаги 1–2 нужны только если хочешь использовать собственное OAuth-приложение.
  </div>

  <h3>Шаг 1 — Создай OAuth-приложение (необязательно)</h3>
  <ol>
    <li>Перейди на <a href="https://oauth.yandex.ru">oauth.yandex.ru</a> → нажми <strong>Создать приложение</strong></li>
    <li>Название: любое — <code>MyDiskSync</code>, <code>my-vscode-app</code> и т.п. Главное чтобы было понятно тебе</li>
    <li>
      <strong>Платформы</strong> → выбери <strong>Веб-сервисы</strong><br>
      <em>(не «Мобильные», не «Десктоп» — именно «Веб-сервисы», это нужно для loopback redirect)</em>
    </li>
    <li>
      В поле <strong>Redirect URI для веб-сервисов</strong> вставь:
      <pre>http://127.0.0.1:8735/oauth-callback</pre>
    </li>
    <li>
      Раздел <strong>Доступы</strong> → нажми <strong>Дополнительные</strong> → добавь права:
      <ul>
        <li>✅ <code>cloud_api:disk.read</code> — «Чтение всего Диска»</li>
        <li>✅ <code>cloud_api:disk.write</code> — «Запись в любом месте на Диске»</li>
        <li>✅ <code>cloud_api:disk.app_folder</code> — «Доступ к папке приложения» (опционально)</li>
      </ul>
    </li>
    <li>Нажми <strong>Создать приложение</strong> → скопируй <strong>ClientID</strong></li>
  </ol>

  <h3>Шаг 2 — Укажи свой Client ID (необязательно)</h3>
  <p>Если используешь собственное приложение: открой <code>Ctrl+,</code> → найди <code>vscodesync.yandexOAuthClientId</code> → вставь свой ClientID:</p>
  <pre>"vscodesync.yandexOAuthClientId": "ВАШ_CLIENT_ID"</pre>
  <p>Если оставить поле пустым — будет использован встроенный Client ID расширения.</p>

  <h3>Шаг 3 — Войди в Яндекс Диск</h3>
  <ol>
    <li><code>Ctrl+Shift+P</code> → <strong>VSCodeSync: Set Active Cloud Provider</strong> → Яндекс Диск</li>
    <li><code>Ctrl+Shift+P</code> → <strong>VSCodeSync: Sign in to Yandex Disk</strong></li>
    <li>Браузер откроется автоматически → войди в Яндекс → нажми <strong>Разрешить</strong></li>
    <li>Страница покажет <strong>✅ VSCodeSync: Яндекс Диск подключён</strong> — вкладку можно закрыть</li>
  </ol>

  <div class="warn">
    Если браузер не открывается или авторизация зависает — используй ручной ввод токена:<br>
    <code>Ctrl+Shift+P</code> → <strong>VSCodeSync: Yandex Disk — ввести токен вручную</strong><br><br>
    Токен можно получить по ссылке (замени CLIENT_ID на свой или встроенный):<br>
    <code>https://oauth.yandex.ru/authorize?response_type=token&amp;client_id=6ee27a62c3ba4b05a69b682bef342570</code>
  </div>
</div>

<!-- ══ ONEDRIVE ═══════════════════════════════════════════════════════════════ -->
<div id="onedrive" class="section">
  <h2>OneDrive (Microsoft)</h2>

  <div class="tip">
    Каждый пользователь регистрирует своё приложение — файлы хранятся в <strong>его</strong> OneDrive, не у разработчика расширения.
  </div>

  <h3>Шаг 1 — Открой портал Azure</h3>
  <ol>
    <li>Перейди на <a href="https://portal.azure.com">portal.azure.com</a></li>
    <li>В левом меню нажми <strong>Microsoft Entra ID</strong></li>
    <li>Слева выбери <strong>App registrations → + New registration</strong></li>
  </ol>

  <h3>Шаг 2 — Заполни форму регистрации</h3>
  <ol>
    <li><strong>Name:</strong> любое — например <code>MyOneDriveSync</code>. Название видно только тебе</li>
    <li>
      <strong>Supported account types:</strong> выбери<br>
      <code>Accounts in any organizational directory (Any Azure AD directory - Multitenant) and personal Microsoft accounts</code><br>
      <em>— это позволяет использовать и личные аккаунты @outlook.com / @hotmail.com и рабочие</em>
    </li>
    <li>
      <strong>Redirect URI:</strong> выбери тип <strong>Public client/native (mobile &amp; desktop)</strong> и вставь:
      <pre>http://127.0.0.1:8736/oauth-callback</pre>
    </li>
    <li>Нажми <strong>Register</strong></li>
  </ol>

  <h3>Шаг 3 — Разреши публичный клиент (для Device Code)</h3>
  <ol>
    <li>В открывшемся приложении перейди в <strong>Authentication</strong></li>
    <li>Прокрути вниз до раздела <strong>Advanced settings</strong></li>
    <li>Переключи <strong>Allow public client flows → Yes</strong></li>
    <li>Нажми <strong>Save</strong></li>
  </ol>

  <h3>Шаг 4 — Скопируй Client ID</h3>
  <ol>
    <li>Перейди в <strong>Overview</strong> приложения</li>
    <li>Скопируй <strong>Application (client) ID</strong> — это GUID вида <code>xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx</code></li>
  </ol>

  <h3>Шаг 5 — Настрой расширение</h3>
  <p>Открой <code>Ctrl+,</code> → найди <code>vscodesync.onedriveClientId</code> → вставь скопированный ID:</p>
  <pre>"vscodesync.onedriveClientId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"</pre>

  <h3>Шаг 6 — Войди в OneDrive</h3>
  <p><code>Ctrl+Shift+P</code> → <strong>VSCodeSync: Войти в облако</strong> → выбери способ:</p>
  <ol>
    <li>
      <strong>OneDrive · браузер (рекомендуется):</strong><br>
      браузер откроется сам → войди в Microsoft → разреши доступ → вкладку можно закрыть.
      Вводить ничего не нужно: ответ возвращается на <code>127.0.0.1:8736</code> —
      тот самый Redirect URI из шага 2.
    </li>
    <li>
      <strong>OneDrive · код устройства</strong> — для SSH, контейнеров и случая,
      когда браузер не открывается:<br>
      в панели Output появится ссылка и код → открой ссылку в любом браузере
      (можно на другой машине) → введи код.
    </li>
  </ol>

  <div class="warn">
    Если при входе Microsoft пишет <em>«Need admin approval»</em> — выбери тип аккаунта
    <strong>Personal accounts only</strong> при регистрации приложения (шаг 2) или войди личным аккаунтом @outlook.com / @hotmail.com.
  </div>
</div>

<!-- ══ GOOGLE DRIVE ════════════════════════════════════════════════════════════ -->
<div id="gdrive" class="section">
  <h2>Google Drive</h2>

  <div class="tip">
    Каждый пользователь регистрирует своё приложение — файлы хранятся в <strong>его</strong> Google Drive, не у разработчика расширения.
  </div>

  <h3>Шаг 1 — Создай проект в Google Cloud</h3>
  <ol>
    <li>Перейди на <a href="https://console.cloud.google.com">console.cloud.google.com</a></li>
    <li>В верхней панели нажми на выпадающий список проектов → <strong>New Project</strong></li>
    <li>Название: любое — например <code>MyDriveSync</code> → <strong>Create</strong></li>
    <li>Убедись, что выбран созданный проект (выпадающий список вверху)</li>
  </ol>

  <h3>Шаг 2 — Включи Google Drive API</h3>
  <ol>
    <li>В левом меню: <strong>APIs &amp; Services → Library</strong></li>
    <li>В поиске введи <code>Google Drive API</code></li>
    <li>Нажми на результат → <strong>Enable</strong></li>
  </ol>

  <h3>Шаг 3 — Настрой OAuth Consent Screen</h3>
  <ol>
    <li><strong>APIs &amp; Services → OAuth consent screen</strong></li>
    <li>Нажми <strong>Get started</strong></li>
    <li><strong>App name:</strong> любое — например <code>MyDriveSync</code>. Укажи свой email в поле поддержки</li>
    <li><strong>Audience:</strong> выбери <strong>External</strong> → <strong>Next</strong></li>
    <li>Contact Information: укажи свой email → <strong>Next</strong> → <strong>Create</strong></li>
    <li>После создания: <strong>Audience → Test users → Add users</strong> → добавь свой Google-аккаунт</li>
  </ol>

  <div class="warn">
    Приложение останется в режиме <strong>Testing</strong> — это нормально для личного использования.
    Войти смогут только аккаунты из списка Test Users (максимум 100).
    Для публичного релиза потребуется верификация Google — это долго и сложно.
  </div>

  <h3>Шаг 4 — Создай OAuth Client ID</h3>
  <ol>
    <li><strong>APIs &amp; Services → Credentials → + Create Credentials → OAuth client ID</strong></li>
    <li><strong>Application type:</strong> <code>Desktop app</code></li>
    <li><strong>Name:</strong> любое — например <code>MyDriveSync</code> → <strong>Create</strong></li>
    <li>В появившемся окне скопируй <strong>Client ID</strong> (длинная строка, заканчивается на <code>.apps.googleusercontent.com</code>)</li>
  </ol>

  <div class="tip">
    Client Secret для Desktop app не нужен — расширение использует PKCE без секрета.
  </div>

  <h3>Шаг 5 — Настрой расширение</h3>
  <p>Открой <code>Ctrl+,</code> → найди <code>vscodesync.googleDriveClientId</code> → вставь скопированный ID:</p>
  <pre>"vscodesync.googleDriveClientId": "xxxxxxxxxxxx.apps.googleusercontent.com"</pre>

  <h3>Шаг 6 — Войди в Google Drive</h3>
  <p><code>Ctrl+Shift+P</code> → <strong>VSCodeSync: Войти в облако</strong> → выбери способ:</p>
  <ol>
    <li>
      <strong>Google Drive · браузер (рекомендуется):</strong><br>
      браузер откроется сам → войди в Google → разреши доступ → вкладку можно закрыть.
      Ответ возвращается на <code>127.0.0.1</code>; для клиента типа
      <code>Desktop app</code> Google принимает loopback на любом порту, отдельно
      регистрировать Redirect URI не нужно
    </li>
    <li>
      <strong>Google Drive · код устройства</strong> — для SSH, контейнеров и случая,
      когда браузер не открывается:<br>
      в панели Output появится ссылка и код → открой ссылку в любом браузере
      (можно на другой машине) → введи код.
    </li>
  </ol>

  <div class="warn">
    Если Google показывает предупреждение <em>«This app isn't verified»</em> — нажми <strong>Advanced → Go to [название твоего приложения] (unsafe)</strong>.
    Это нормально для приложений в режиме Testing, которые ты создал сам.
  </div>
</div>

<!-- ══ DROPBOX ════════════════════════════════════════════════════════════════ -->
<div id="dropbox" class="section">
  <h2>Dropbox</h2>

  <div class="tip">
    Каждый пользователь регистрирует своё приложение — файлы хранятся в <strong>его</strong> Dropbox, не у разработчика расширения.
  </div>

  <h3>Шаг 1 — Создай приложение на портале Dropbox</h3>
  <ol>
    <li>Перейди на <a href="https://www.dropbox.com/developers/apps">dropbox.com/developers/apps</a> → нажми <strong>Create app</strong></li>
    <li><strong>Choose an API:</strong> выбери <strong>Scoped access</strong></li>
    <li><strong>Choose the type of access:</strong> выбери <strong>Full Dropbox</strong><br>
      <em>— это нужно для создания папки <code>VSCodeSyncFiles/</code> в корне Dropbox</em>
    </li>
    <li><strong>Name your app:</strong> любое — например <code>MyDropboxSync</code> или <code>vscode-files</code>.<br>
      <em>Название видно только тебе и не влияет на работу расширения</em>
    </li>
    <li>Нажми <strong>Create app</strong></li>
  </ol>

  <h3>Шаг 2 — Добавь Redirect URI</h3>
  <ol>
    <li>В созданном приложении перейди на вкладку <strong>Settings</strong></li>
    <li>Найди раздел <strong>OAuth 2 → Redirect URIs</strong></li>
    <li>Вставь и нажми <strong>Add</strong>:
      <pre>http://127.0.0.1:8734/oauth-callback</pre>
    </li>
  </ol>

  <h3>Шаг 3 — Настрой права доступа</h3>
  <ol>
    <li>Перейди на вкладку <strong>Permissions</strong></li>
    <li>Включи следующие права:
      <ul>
        <li>✅ <code>files.content.write</code> — запись файлов</li>
        <li>✅ <code>files.content.read</code> — чтение файлов</li>
        <li>✅ <code>files.metadata.read</code> — чтение метаданных (обычно уже включён)</li>
      </ul>
    </li>
    <li>Нажми <strong>Submit</strong> внизу страницы — без этого права не сохранятся</li>
  </ol>

  <div class="warn">
    Если после авторизации возникает ошибка доступа — убедись, что нажал <strong>Submit</strong> на вкладке Permissions, и повтори вход.
  </div>

  <h3>Шаг 4 — Скопируй App key</h3>
  <ol>
    <li>Вернись на вкладку <strong>Settings</strong></li>
    <li>Скопируй <strong>App key</strong> — короткая строка букв и цифр</li>
  </ol>

  <h3>Шаг 5 — Настрой расширение</h3>
  <p>Открой <code>Ctrl+,</code> → найди <code>vscodesync.dropboxAppKey</code> → вставь скопированный ключ:</p>
  <pre>"vscodesync.dropboxAppKey": "ВАШ_APP_KEY"</pre>

  <h3>Шаг 6 — Войди в Dropbox</h3>
  <ol>
    <li><code>Ctrl+Shift+P</code> → <strong>VSCodeSync: Set Active Cloud Provider</strong> → Dropbox</li>
    <li><code>Ctrl+Shift+P</code> → <strong>VSCodeSync: Sign in to Dropbox</strong></li>
    <li>Браузер откроется автоматически → войди в Dropbox → разреши доступ → вкладку можно закрыть</li>
  </ol>

  <div class="tip">
    Для SSH / headless-серверов используй <strong>VSCodeSync: Sign in to Dropbox (headless)</strong> —
    в панели Output появится ссылка, которую можно открыть в браузере на другой машине.
  </div>
</div>

<script>
  function show(id, btn) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    btn.classList.add('active');
  }
</script>
</body>
</html>`;
}
