import { runPull } from "./cmdPull.js";
import { runStatus } from "./cmdStatus.js";
import { runAuth } from "./cmdAuth.js";
import { EXIT_GENERAL, EXIT_OK } from "./exitCodes.js";
import { parseArgv } from "./parseArgs.js";

declare const __CLI_VERSION__: string;

function readCliVersion(): string {
  return typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0";
}

function printHelp(): void {
  console.log(`vscodesync — VSCodeSync CLI (без VS Code). Версия ${readCliVersion()}

Использование:
  vscodesync status [--cwd <dir>]
  vscodesync pull [--cwd <dir>] [--workspace <id>] [--token <access_token>]
  vscodesync pull-all   (то же, что pull)
  vscodesync auth --device-code [--provider onedrive] [--client-id <azure_app_id>]

Auth:
  Первый запуск: vscodesync auth --device-code --client-id <id>
  После авторизации токен сохраняется в ~/.vscode/vscodeSync/cli-credentials.json
  и используется автоматически командами pull / pull-all.

Облако (pull): глобальный ~/.vscode/vscodeSync/config.json → activeProvider=onedrive.

Переменные:
  VSCODESYNC_TOKEN              OAuth access token (приоритет над credentials-файлом)
  VSCODESYNC_ONEDRIVE_CLIENT_ID Azure App Client ID (альтернатива --client-id)
  VSCODESYNC_MAX_FILE_MB        лимит размера файла (по умолчанию 5)

Остальные команды из roadmap (push, transfer, …) — по мере развития CLI.
`);
}
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv);

  if (parsed.help) {
    printHelp();
    return EXIT_OK;
  }
  if (parsed.version) {
    console.log(readCliVersion());
    return EXIT_OK;
  }

  if (parsed.command === "auth" && parsed.auth) {
    return runAuth(parsed.auth);
  }

  if (parsed.command === "status" && parsed.status) {
    return runStatus(parsed.status.cwd);
  }

  if (parsed.command === "pull" || parsed.command === "pull-all") {
    if (!parsed.pull) {
      printHelp();
      return EXIT_GENERAL;
    }
    return runPull(parsed.pull);
  }

  printHelp();
  return EXIT_GENERAL;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error("VSCodeSync CLI:", e instanceof Error ? e.message : String(e));
    process.exitCode = EXIT_GENERAL;
  });
