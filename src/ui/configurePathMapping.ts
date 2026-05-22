import * as vscode from "vscode";
import * as path from "node:path";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { PathMappingError, resolveEffectiveSyncRoot } from "../core/pathMapping.js";
import { resolveWorkspaceRootForPaletteCommand } from "../utils/workspaceRootResolver.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";

function omitMachineMapping(map: Record<string, string>, machineKey: string): Record<string, string> | undefined {
  const entries = Object.entries(map).filter(([k]) => k !== machineKey);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * Palette command: edit `pathMapping` for current machine (`machineName`) without manual JSON hunting.
 */
export async function runConfigurePathMapping(globalConfig: GlobalConfigManager): Promise<void> {
  if (!(await assertWorkspaceTrusted())) {
    return;
  }
  const root = await resolveWorkspaceRootForPaletteCommand();
  if (!root) {
    await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
    return;
  }
  const gc = await globalConfig.load();
  const mn = gc.machineName.trim();
  let cfg = await WorkspaceConfigManager.load(root);
  const cur = cfg.pathMapping?.[mn]?.trim() ?? "";

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(folder) Выбрать каталог…",
        description: cur ? cur : path.basename(root),
        pick: "folder" as const,
      },
      {
        label: "$(edit) Ввести абсолютный путь…",
        description: "",
        pick: "input" as const,
      },
      {
        label: "$(trash) Сбросить для этой машины",
        description: "Использовать корень workspace",
        pick: "clear" as const,
      },
      {
        label: "$(json) Открыть .vscode/vscodesync.json",
        description: "",
        pick: "openjson" as const,
      },
    ],
    { placeHolder: `Корень синхронизации для машины «${mn}» (pathMapping)` },
  );
  if (!choice || !("pick" in choice)) {
    return;
  }

  switch (choice.pick) {
    case "openjson": {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(WorkspaceConfigManager.getConfigPath(root)));
      await vscode.window.showTextDocument(doc);
      return;
    }
    case "clear": {
      const mapping = { ...(cfg.pathMapping ?? {}) };
      cfg = { ...cfg, pathMapping: omitMachineMapping(mapping, mn) };
      try {
        validateMapping(root, cfg.pathMapping, mn);
      } catch (e) {
        await vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        return;
      }
      await WorkspaceConfigManager.save(cfg, root);
      void vscode.window.showInformationMessage(`VSCodeSync: для «${mn}» используется корень workspace.`);
      return;
    }
    default:
      break;
  }

  let nextPath = "";
  if (choice.pick === "folder") {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: cur ? vscode.Uri.file(cur) : vscode.Uri.file(root),
      openLabel: "Выбрать корень синхронизации",
    });
    const uri = picked?.[0];
    if (!uri) {
      return;
    }
    nextPath = uri.fsPath;
  } else {
    const typed = await vscode.window.showInputBox({
      prompt: `Абсолютный путь для «${mn}» (корень синхронизируемых файлов)`,
      value: cur || root,
      validateInput: (v) => {
        const t = v.trim();
        if (!t) {
          return "Нужен непустой путь или отмена";
        }
        if (!path.isAbsolute(t)) {
          return "Укажите абсолютный путь";
        }
        return null;
      },
    });
    if (!typed?.trim()) {
      return;
    }
    nextPath = typed.trim();
  }

  const mapping = { ...(cfg.pathMapping ?? {}) };
  mapping[mn] = path.resolve(nextPath);
  cfg = { ...cfg, pathMapping: mapping };

  try {
    validateMapping(root, cfg.pathMapping, mn);
  } catch (e) {
    const msg = e instanceof PathMappingError ? e.message : e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(`VSCodeSync: ${msg}`);
    return;
  }

  await WorkspaceConfigManager.save(cfg, root);
  void vscode.window.showInformationMessage(`VSCodeSync: pathMapping для «${mn}» → ${mapping[mn] ?? ""}`);
}

function validateMapping(workspaceRoot: string, pathMapping: Record<string, string> | undefined, machineName: string): void {
  resolveEffectiveSyncRoot(workspaceRoot, pathMapping, machineName);
}
