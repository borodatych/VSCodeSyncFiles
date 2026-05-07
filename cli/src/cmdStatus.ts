import * as fs from "node:fs/promises";

import { GlobalConfigManager } from "../../src/core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";
import { EXIT_GENERAL, EXIT_OK } from "./exitCodes.js";

export async function runStatus(cwd: string): Promise<number> {
  const gcm = new GlobalConfigManager(GlobalConfigManager.resolveDefaultConfigDir(), undefined);
  let gc;
  try {
    gc = await gcm.load();
  } catch (e) {
    console.error("VSCodeSync CLI: не удалось прочитать глобальный config:", e);
    return EXIT_GENERAL;
  }

  console.log("machineId:", gc.machineId);
  console.log("machineName:", gc.machineName);
  console.log("activeProvider:", gc.activeProvider ?? "(не задан)");
  console.log("config:", gcm.getConfigPath());

  try {
    await fs.access(cwd);
  } catch {
    console.error(`VSCodeSync CLI: cwd не найден: ${cwd}`);
    return EXIT_GENERAL;
  }

  const wc = await WorkspaceConfigManager.load(cwd);
  console.log("workspace folder:", cwd);
  console.log("activeWorkspaces (локально):", wc.activeWorkspaces.length);
  for (const w of wc.activeWorkspaces) {
    console.log(`  - ${w.workspaceNote} (${w.workspaceId})`);
  }
  console.log("tracked files:", wc.files.length);
  return EXIT_OK;
}
