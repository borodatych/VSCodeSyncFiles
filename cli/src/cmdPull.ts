import * as fs from "node:fs/promises";

import { GlobalConfigManager } from "../../src/core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";
import { OneDriveProvider } from "../../src/providers/onedrive/onedriveProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import { createCliSyncEngine } from "./engineCli.js";
import { EXIT_AUTH, EXIT_GENERAL, EXIT_NOT_FOUND, EXIT_OK } from "./exitCodes.js";
import { createAutoSecretStore, hasAnyCredentials } from "./secretStoreEnv.js";
import type { ParsedPullArgs } from "./parseArgs.js";

async function resolveWorkspaceId(
  cwd: string,
  requested: string | undefined,
): Promise<{ workspaceId?: string; error?: string }> {
  const wc = await WorkspaceConfigManager.load(cwd);
  if (wc.activeWorkspaces.length === 0) {
    return { error: "VSCodeSync CLI: в .vscode/vscodesync.json нет активных workspace." };
  }
  if (requested?.trim()) {
    const id = requested.trim();
    const hit = wc.activeWorkspaces.find((w) => w.workspaceId === id);
    return hit ? { workspaceId: hit.workspaceId } : { error: `VSCodeSync CLI: workspace ${id} не найден в конфиге.` };
  }
  if (wc.activeWorkspaces.length === 1) {
    return { workspaceId: wc.activeWorkspaces[0]?.workspaceId };
  }
  return {
    error:
      'VSCodeSync CLI: несколько workspace — укажите --workspace <id> (как в tasks.json "workspace").',
  };
}

export async function runPull(args: ParsedPullArgs): Promise<number> {
  const cwd = args.cwd;

  try {
    await fs.access(cwd);
  } catch {
    console.error(`VSCodeSync CLI: cwd не найден: ${cwd}`);
    return EXIT_GENERAL;
  }

  if (!await hasAnyCredentials(args.token)) {
    console.error(
      "VSCodeSync CLI: токен не найден. Укажите --token <access_token>, задайте VSCODESYNC_TOKEN, или запустите: vscodesync auth --device-code",
    );
    return EXIT_AUTH;
  }

  const gcm = new GlobalConfigManager(GlobalConfigManager.resolveDefaultConfigDir(), undefined);
  const gc = await gcm.load();
  if (gc.activeProvider !== "onedrive") {
    console.error(
      `VSCodeSync CLI: в global config activeProvider=${String(gc.activeProvider)} — сейчас поддерживается только onedrive.`,
    );
    return EXIT_GENERAL;
  }

  const secrets = createAutoSecretStore(args.token);
  const provider = new OneDriveProvider(secrets);
  try {
    if (!(await provider.isAuthenticated())) {
      console.error("VSCodeSync CLI: токен не принят OneDrive (проверьте VSCODESYNC_TOKEN).");
      return EXIT_AUTH;
    }
  } catch (e) {
    console.error("VSCodeSync CLI:", e instanceof Error ? e.message : String(e));
    return EXIT_AUTH;
  }

  const ws = await resolveWorkspaceId(cwd, args.workspace);
  if (ws.error) {
    console.error(ws.error);
    return EXIT_NOT_FOUND;
  }

  const engine = createCliSyncEngine(cwd, provider, gc.machineId, gc.machineName);

  try {
    await engine.pullAll(ws.workspaceId);
  } catch (e) {
    if (e instanceof ProviderError && e.code === "UNAUTHORIZED") {
      console.error("VSCodeSync CLI: авторизация облака:", e.message);
      return EXIT_AUTH;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/workspace not active|no manifest/i.test(msg)) {
      console.error("VSCodeSync CLI:", msg);
      return EXIT_NOT_FOUND;
    }
    console.error("VSCodeSync CLI:", msg);
    return EXIT_GENERAL;
  }

  console.log("VSCodeSync CLI: pull выполнен.");
  return EXIT_OK;
}
