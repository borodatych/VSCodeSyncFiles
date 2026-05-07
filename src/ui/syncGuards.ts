import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ActiveWorkspaceEntry, WorkspaceConfig } from "../core/types.js";
import {
  buildCombinedIgnoreRules,
  trackedPosixRelForIgnore,
} from "../core/workspaceIgnoreRules.js";
import { fileLooksBinary } from "../utils/binaryDetect.js";
import { isIgnoredByRules } from "../utils/ignoreMatch.js";

const CFG_SECTION = "vscodesync";

export async function confirmAddFilePreview(fsPath: string): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
  if (!cfg.get<boolean>("showPreview", true)) {
    return true;
  }
  let kb = 0;
  try {
    const st = await fs.stat(fsPath);
    kb = Math.ceil(st.size / 1024);
  } catch {
    /* ignore */
  }
  const picked = await vscode.window.showInformationMessage(
    `Добавить в VSCodeSync: ${path.basename(fsPath)} (~${String(kb)} KB)?`,
    { modal: true },
    "Добавить",
  );
  return picked === "Добавить";
}

export async function confirmBinaryUpload(fsPath: string): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
  if (!cfg.get<boolean>("warnOnBinaryFiles", true)) {
    return true;
  }
  if (!(await fileLooksBinary(fsPath))) {
    return true;
  }
  const picked = await vscode.window.showWarningMessage(
    `Файл «${path.basename(fsPath)}» похож на двоичный. Всё равно синхронизировать?`,
    { modal: true },
    "Продолжить",
  );
  return picked === "Продолжить";
}

async function confirmBinaryUploadBatch(binaryPaths: string[]): Promise<boolean> {
  if (binaryPaths.length === 0) {
    return true;
  }
  const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
  if (!cfg.get<boolean>("warnOnBinaryFiles", true)) {
    return true;
  }
  const sample = binaryPaths
    .slice(0, 5)
    .map((p) => path.basename(p))
    .join(", ");
  const more =
    binaryPaths.length > 5
      ? ` и ещё ${String(binaryPaths.length - 5)}`
      : "";
  const picked = await vscode.window.showWarningMessage(
    `В выборке ${String(binaryPaths.length)} двоичных файл(ов): ${sample}${more}. Синхронизировать все?`,
    { modal: true },
    "Продолжить",
  );
  return picked === "Продолжить";
}

export { buildCombinedIgnoreRules, trackedPosixRelForIgnore } from "../core/workspaceIgnoreRules.js";

/**
 * Workspace ignore stack (global file + shared manifest + local config). Paths use tracked posix (pathMapping-aware).
 */
export async function checkWorkspaceIgnoreGuard(
  workspaceRoot: string,
  fsPath: string,
  entry: ActiveWorkspaceEntry | undefined,
  cfg?: WorkspaceConfig,
  machineName?: string,
): Promise<boolean> {
  const rules = await buildCombinedIgnoreRules(workspaceRoot, entry);
  if (rules.length === 0) {
    return true;
  }
  const posixRel = trackedPosixRelForIgnore(workspaceRoot, fsPath, cfg, machineName);
  if (isIgnoredByRules(posixRel, rules)) {
    await vscode.window.showErrorMessage(
      `VSCodeSync: файл «${path.basename(fsPath)}» совпадает с правилом исключения (.vscodesync-ignore → shared паттерны в манифесте → локальные ignorePatterns).`,
    );
    return false;
  }
  return true;
}

export interface WorkspaceIgnoreGuardOptions {
  /** Active workspace entry for `sharedIgnorePatterns` / `ignorePatterns`. */
  entry?: ActiveWorkspaceEntry;
  cfg?: WorkspaceConfig;
  machineName?: string;
}

/** Preview + предупреждение о бинарниках + combined ignore перед добавлением в sync. */
export async function guardPathsBeforeAdd(
  paths: string[],
  withPreview: boolean,
  workspaceRoot?: string,
  opts?: WorkspaceIgnoreGuardOptions,
): Promise<boolean> {
  if (paths.length === 0) {
    return true;
  }
  const previewThisMany = withPreview && paths.length === 1;
  for (const p of paths) {
    if (
      workspaceRoot &&
      !(await checkWorkspaceIgnoreGuard(
        workspaceRoot,
        p,
        opts?.entry,
        opts?.cfg,
        opts?.machineName,
      ))
    ) {
      return false;
    }
    if (previewThisMany && !(await confirmAddFilePreview(p))) {
      return false;
    }
  }
  if (paths.length > 1) {
    const binaries: string[] = [];
    for (const p of paths) {
      if (await fileLooksBinary(p)) {
        binaries.push(p);
      }
    }
    if (!(await confirmBinaryUploadBatch(binaries))) {
      return false;
    }
  } else {
    const onlyPath = paths.at(0);
    if (onlyPath !== undefined && !(await confirmBinaryUpload(onlyPath))) {
      return false;
    }
  }
  return true;
}

export async function guardPathsBeforePush(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    if (!(await confirmBinaryUpload(p))) {
      return false;
    }
  }
  return true;
}
