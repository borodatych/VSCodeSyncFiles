/**
 * User-facing half of P2P staging (B15): a delivery has landed in
 * `.vscode/vscodesync-incoming/` and now needs a decision.
 *
 * Apply / compare / reject — and "apply" keeps a copy of whatever it replaces,
 * exactly like a pull does.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { backupExistingUserFile } from "../core/localFileBackup.js";
import { writeFileAtomic } from "../core/writeTextFileAtomic.js";
import { readLocalBackupSettings } from "./localBackupSettings.js";
import { warnLog } from "../utils/log.js";

export interface StagedP2PFile {
  relPath: string;
  workspaceRoot: string;
  stagingAbs: string;
  targetAbs: string;
  bytes: number;
}

export async function promptStagedP2PFile(info: StagedP2PFile, peerLabel: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `VSCodeSync: получен файл «${info.relPath}» от ${peerLabel} (${String(info.bytes)} Б). Он ждёт в ${path.relative(info.workspaceRoot, info.stagingAbs)}.`,
    "Применить",
    "Сравнить",
    "Отклонить",
  );
  if (choice === "Сравнить") {
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(info.targetAbs),
      vscode.Uri.file(info.stagingAbs),
      `${info.relPath}: локальная ↔ входящая (P2P)`,
    );
    // Deliberately no second prompt: the staged file stays put, and the user
    // re-runs the decision from the diff view when ready.
    return;
  }
  if (choice === "Отклонить") {
    await fs.rm(info.stagingAbs, { force: true });
    return;
  }
  if (choice !== "Применить") {
    return;
  }
  try {
    const backupCfg = readLocalBackupSettings(info.workspaceRoot);
    if (backupCfg.enabled) {
      await backupExistingUserFile({
        absPath: info.targetAbs,
        workspaceRoot: info.workspaceRoot,
        posixRel: info.relPath,
        retentionDays: backupCfg.retentionDays,
        backupDir: backupCfg.backupDir,
      });
    }
    await writeFileAtomic(info.targetAbs, await fs.readFile(info.stagingAbs));
    await fs.rm(info.stagingAbs, { force: true });
    void vscode.window.showInformationMessage(`VSCodeSync: «${info.relPath}» применён.`);
  } catch (e) {
    warnLog("p2p-receive", `apply ${info.relPath} failed: ${e instanceof Error ? e.message : String(e)}`);
    void vscode.window.showErrorMessage(
      `VSCodeSync: не удалось применить «${info.relPath}» — файл остался в ${path.relative(info.workspaceRoot, info.stagingAbs)}.`,
    );
  }
}
