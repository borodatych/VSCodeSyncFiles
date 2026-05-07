import { runOneDriveDeviceCodeLogin } from "../../src/providers/onedrive/onedriveDeviceCode.js";
import { createFileSecretStore, getDefaultCredentialsPath } from "./credentialStore.js";
import { EXIT_AUTH, EXIT_GENERAL, EXIT_OK } from "./exitCodes.js";
import type { ParsedAuthArgs } from "./parseArgs.js";

export async function runAuth(args: ParsedAuthArgs): Promise<number> {
  if (!args.deviceCode) {
    console.error("VSCodeSync CLI: используйте --device-code для интерактивной авторизации.");
    return EXIT_GENERAL;
  }

  const provider = args.provider;

  if (provider !== "onedrive") {
    console.error(
      `VSCodeSync CLI: auth --device-code поддерживается для: onedrive. Получено: ${provider}.`,
    );
    return EXIT_GENERAL;
  }

  const explicitClient = args.clientId?.trim();
  const envClient = process.env.VSCODESYNC_ONEDRIVE_CLIENT_ID?.trim();
  const clientId = explicitClient && explicitClient.length > 0 ? explicitClient : envClient;

  if (!clientId) {
    console.error(
      "VSCodeSync CLI: укажите --client-id <azure_app_id> или задайте VSCODESYNC_ONEDRIVE_CLIENT_ID.",
    );
    return EXIT_GENERAL;
  }

  const store = createFileSecretStore();

  try {
    await runOneDriveDeviceCodeLogin(store, clientId, (uri, code, msg) => {
      console.log(`\n${msg}`);
      console.log(`\n  Откройте: ${uri}`);
      console.log(`  Введите код: ${code}\n`);
      console.log("Ожидание авторизации…");
    });
    console.log(
      `\nVSCodeSync CLI: авторизация OneDrive выполнена.\nТокен сохранён → ${getDefaultCredentialsPath()}`,
    );
    console.log("Теперь можно запускать: vscodesync pull / pull-all");
    return EXIT_OK;
  } catch (e) {
    console.error(
      "VSCodeSync CLI: auth ошибка —",
      e instanceof Error ? e.message : String(e),
    );
    return EXIT_AUTH;
  }
}
