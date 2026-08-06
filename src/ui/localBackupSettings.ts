/**
 * One reader for the three `localBackup*` settings.
 *
 * Stage 3.6 gave three more call sites a reason to back a user file up before
 * overwriting it (AI merge, Quick Transfer receive, P2P apply); the engine
 * factory already read the same keys for pull.
 */
import * as vscode from "vscode";
import { LOCAL_BACKUP_DIR_DEFAULT } from "../core/localFileBackup.js";

const CFG_SECTION = "vscodesync";

export interface LocalBackupSettings {
  /** `false` disables the pre-overwrite copy entirely. */
  enabled: boolean;
  workspaceRoot: string;
  retentionDays: number;
  backupDir: string;
}

export function readLocalBackupSettings(workspaceRoot: string): LocalBackupSettings {
  const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
  return {
    enabled: cfg.get<boolean>("localBackupEnabled", true),
    workspaceRoot,
    retentionDays: cfg.get<number>("localBackupRetentionDays", 7),
    backupDir: cfg.get<string>("localBackupDir", LOCAL_BACKUP_DIR_DEFAULT),
  };
}
