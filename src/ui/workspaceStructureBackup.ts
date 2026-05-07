import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import {
  classifyWorkspaceStructureImport,
  parseWorkspaceStructureImport,
  parseWorkspaceStructureLite,
  WORKSPACE_STRUCTURE_EXPORT_SCHEMA,
  WORKSPACE_STRUCTURE_LITE_SCHEMA,
} from "../core/workspaceStructureImport.js";
import { manifestCloudPath } from "../core/cloudLayout.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";
import { guardPathsBeforeAdd } from "./syncGuards.js";

export {
  parseWorkspaceStructureImport,
  parseWorkspaceStructureLite,
  classifyWorkspaceStructureImport,
} from "../core/workspaceStructureImport.js";

export interface WorkspaceStructureIoDeps {
  globalConfig: GlobalConfigManager;
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
  ) => SyncEngine;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
}

async function backupLocalConfig(workspaceRoot: string): Promise<void> {
  const cfgPath = WorkspaceConfigManager.getConfigPath(workspaceRoot);
  try {
    await fs.copyFile(cfgPath, `${cfgPath}.import-${String(Date.now())}.bak`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
}

function resolveImportPaths(
  workspaceRoot: string,
  relPaths: string[],
): { rel: string; abs: string }[] {
  const rootResolved = path.resolve(workspaceRoot);
  const out: { rel: string; abs: string }[] = [];
  for (const raw of relPaths) {
    const rel = raw
      .split(/[/\\]+/)
      .filter((s) => s.length > 0 && s !== ".")
      .join("/");
    if (rel.length === 0 || rel.includes("..")) {
      throw new Error(`недопустимый путь: ${raw}`);
    }
    const abs = path.resolve(rootResolved, rel);
    const relToRoot = path.relative(rootResolved, abs);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      throw new Error(`путь вне папки проекта: ${raw}`);
    }
    out.push({ rel, abs });
  }
  return out;
}

async function pathsExist(paths: { abs: string }[]): Promise<string[]> {
  const missing: string[] = [];
  for (const { abs } of paths) {
    try {
      await fs.access(abs);
    } catch {
      missing.push(abs);
    }
  }
  return missing;
}

async function cloudManifestExists(provider: ICloudProvider, workspaceId: string): Promise<boolean> {
  try {
    await provider.downloadFile(manifestCloudPath(workspaceId));
    return true;
  } catch (e) {
    if (e instanceof ProviderError && e.code === "NOT_FOUND") {
      return false;
    }
    throw e;
  }
}

async function pickActiveWorkspaceId(cfg: Awaited<ReturnType<typeof WorkspaceConfigManager.load>>): Promise<
  string | undefined
> {
  if (cfg.activeWorkspaces.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace для экспорта.");
    return undefined;
  }
  if (cfg.activeWorkspaces.length === 1) {
    return cfg.activeWorkspaces[0]?.workspaceId;
  }
  type P = vscode.QuickPickItem & { workspaceId: string };
  const picked = await vscode.window.showQuickPick<P>(
    cfg.activeWorkspaces.map((w) => ({
      label: w.workspaceNote || w.workspaceId,
      description: w.workspaceId,
      workspaceId: w.workspaceId,
    })),
    { placeHolder: "Какой workspace экспортировать (портативная структура)?" },
  );
  return picked?.workspaceId;
}

/** Экспорт портативной структуры (schema 2) — без токенов, ETag и хэшей. */
export async function exportWorkspaceStructure(workspaceRoot: string, machineName: string): Promise<void> {
  const cfg = await WorkspaceConfigManager.load(workspaceRoot);
  const wsId = await pickActiveWorkspaceId(cfg);
  if (!wsId) {
    return;
  }
  const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === wsId);
  const note = entry?.workspaceNote ?? wsId;
  const files = [...new Set(cfg.files.filter((f) => f.workspaceId === wsId).map((f) => f.localPath))];
  if (files.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: в этом workspace нет отслеживаемых файлов.");
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(workspaceRoot, "vscodesync-workspace-structure.json")),
    filters: { JSON: ["json"] },
    saveLabel: "Экспорт",
  });
  if (!uri) {
    return;
  }
  const payload = {
    schema: WORKSPACE_STRUCTURE_LITE_SCHEMA,
    sourceWorkspaceId: wsId,
    workspaceNote: note,
    files,
    exportedAt: new Date().toISOString(),
    exportedBy: machineName,
  };
  await fs.writeFile(uri.fsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await vscode.window.showInformationMessage(`Портативная структура сохранена: ${uri.fsPath}`);
}

/** Полный дамп локального кэша (schema 1) — для переноса между чек-аутами той же машины / бэкапа. */
export async function exportWorkspaceStructureFullCache(workspaceRoot: string): Promise<void> {
  const cfg = await WorkspaceConfigManager.load(workspaceRoot);
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(workspaceRoot, "vscodesync-local-cache-export.json")),
    filters: { JSON: ["json"] },
    saveLabel: "Экспорт кэша",
  });
  if (!uri) {
    return;
  }
  const payload = {
    schema: WORKSPACE_STRUCTURE_EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    activeWorkspaces: cfg.activeWorkspaces,
    files: cfg.files,
    ...(cfg.pathMapping !== undefined ? { pathMapping: cfg.pathMapping } : {}),
  };
  await fs.writeFile(uri.fsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await vscode.window.showInformationMessage(`Локальный кэш экспортирован: ${uri.fsPath}`);
}

async function importLitePortable(
  workspaceRoot: string,
  lite: ReturnType<typeof parseWorkspaceStructureLite>,
  deps: WorkspaceStructureIoDeps,
): Promise<void> {
  const provider = await deps.tryAuthenticatedProvider();
  if (!provider) {
    await vscode.window.showWarningMessage("VSCodeSync: нужен авторизованный облачный провайдер для импорта структуры.");
    return;
  }
  const gc = await deps.globalConfig.load();
  const resolved = resolveImportPaths(workspaceRoot, lite.files);
  const missing = await pathsExist(resolved);
  if (missing.length > 0) {
    await vscode.window.showErrorMessage(
      `VSCodeSync: не найдены локально ${String(missing.length)} файл(ов) из списка; проверьте, что открыта нужная папка проекта.`,
    );
    return;
  }
  const existsOnCloud = await cloudManifestExists(provider, lite.sourceWorkspaceId);
  const cfg0 = await WorkspaceConfigManager.load(workspaceRoot);
  const already = cfg0.activeWorkspaces.some((w) => w.workspaceId === lite.sourceWorkspaceId);

  let mode: "attach" | "create" | "extend_local" | undefined;

  if (already) {
    mode = "extend_local";
  } else if (existsOnCloud) {
    const choice = await vscode.window.showInformationMessage(
      `На облаке найден workspace «${lite.workspaceNote}» (${lite.sourceWorkspaceId}). Подключиться к нему или создать новый workspace?`,
      { modal: true },
      "Подключиться",
      "Новый workspace",
      "Отмена",
    );
    if (choice === "Отмена" || choice === undefined) {
      return;
    }
    mode = choice === "Подключиться" ? "attach" : "create";
  } else {
    const go = await vscode.window.showWarningMessage(
      "Облачный манифест для sourceWorkspaceId не найден (новый проект или другой аккаунт). Создать новый workspace и залить локальные файлы?",
      { modal: true },
      "Создать новый",
      "Отмена",
    );
    if (go !== "Создать новый") {
      return;
    }
    mode = "create";
  }

  await backupLocalConfig(workspaceRoot);
  const engine = deps.makeEngine(workspaceRoot, provider, gc.machineId, gc.machineName);
  const absPaths = resolved.map((r) => r.abs);

  if (mode === "extend_local") {
    const cfg = await WorkspaceConfigManager.load(workspaceRoot);
    const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === lite.sourceWorkspaceId);
    if (!ent) {
      throw new Error("workspace не найден после перечитывания конфига");
    }
    const tracked = new Set(cfg.files.filter((f) => f.workspaceId === lite.sourceWorkspaceId).map((f) => f.localPath));
    const toAdd = resolved.filter((r) => !tracked.has(r.rel)).map((r) => r.abs);
    if (toAdd.length === 0) {
      await vscode.window.showInformationMessage("VSCodeSync: все файлы из списка уже в синхронизации.");
      return;
    }
    if (
      !(await guardPathsBeforeAdd(toAdd, false, workspaceRoot, {
        entry: ent,
        cfg,
        machineName: gc.machineName,
      }))
    ) {
      return;
    }
    await engine.addFiles(lite.sourceWorkspaceId, toAdd);
    await vscode.window.showInformationMessage(`VSCodeSync: добавлено файлов: ${String(toAdd.length)}.`);
    return;
  }

  if (mode === "attach") {
    await engine.attachCloudWorkspace(lite.sourceWorkspaceId);
    const cfg = await WorkspaceConfigManager.load(workspaceRoot);
    const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === lite.sourceWorkspaceId);
    if (!ent) {
      throw new Error("после подключения workspace не найден в конфиге");
    }
    const tracked = new Set(cfg.files.map((f) => f.localPath));
    const toAdd = resolved.filter((r) => !tracked.has(r.rel)).map((r) => r.abs);
    if (toAdd.length > 0) {
      if (
        !(await guardPathsBeforeAdd(toAdd, false, workspaceRoot, {
          entry: ent,
          cfg,
          machineName: gc.machineName,
        }))
      ) {
        return;
      }
      await engine.addFiles(lite.sourceWorkspaceId, toAdd);
    }
    await vscode.window.showInformationMessage(
      "VSCodeSync: workspace подключён с облака; при конфликтах контента используйте дерево синхронизации и «Diff с облаком».",
    );
    return;
  }

  /* create */
  const providerType = gc.activeProvider ?? "onedrive";
  const newId = await engine.createWorkspace(lite.workspaceNote || "Imported", providerType);
  const cfgAfter = await WorkspaceConfigManager.load(workspaceRoot);
  const entNew = cfgAfter.activeWorkspaces.find((w) => w.workspaceId === newId);
  if (
    !entNew ||
    !(await guardPathsBeforeAdd(absPaths, false, workspaceRoot, {
      entry: entNew,
      cfg: cfgAfter,
      machineName: gc.machineName,
    }))
  ) {
    return;
  }
  await engine.addFiles(newId, absPaths);
  await vscode.window.showInformationMessage(`VSCodeSync: создан workspace ${newId}, файлы добавлены в синхронизацию.`);
}

export async function importWorkspaceStructure(workspaceRoot: string, deps: WorkspaceStructureIoDeps): Promise<void> {
  if (!(await assertWorkspaceTrusted())) {
    return;
  }
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { JSON: ["json"] },
    openLabel: "Импорт",
  });
  const uri = uris?.[0];
  if (!uri) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(uri.fsPath, "utf8")) as unknown;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const kind = classifyWorkspaceStructureImport(parsed);
  if (kind === "invalid") {
    throw new Error("неподдерживаемый формат JSON (нужен schema 2 или полный кэш vscodesync.json)");
  }
  if (kind === "lite_portable") {
    const lite = parseWorkspaceStructureLite(parsed);
    await importLitePortable(workspaceRoot, lite, deps);
    return;
  }

  const next = parseWorkspaceStructureImport(parsed);
  const confirm = await vscode.window.showWarningMessage(
    `Заменить локальный vscodesync.json полным кэшем? Workspace: ${String(next.activeWorkspaces.length)}, файлов: ${String(next.files.length)}. Текущий файл будет скопирован в .bak.`,
    { modal: true },
    "Заменить",
  );
  if (confirm !== "Заменить") {
    return;
  }
  await backupLocalConfig(workspaceRoot);
  await WorkspaceConfigManager.save(next, workspaceRoot);
  await vscode.window.showInformationMessage("vscodesync.json восстановлен из полного экспорта кэша.");
}
