import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import { normalizeIgnorePatternStrings, normalizeIgnorePatternLinesFromText } from "../utils/ignorePatternNormalize.js";
import { resolveWorkspaceRootForPaletteCommand } from "../utils/workspaceRootResolver.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";
import { readEditorConfigSuggestedLineEnding } from "../utils/editorConfigEndOfLine.js";

const CFG = "vscodesync";

async function openGlobalVscodesyncIgnoreFile(workspaceRoot: string): Promise<void> {
  const fp = path.join(workspaceRoot, ".vscodesync-ignore");
  try {
    await fs.access(fp);
  } catch {
    const defaultContent =
      "# Паттерны как в .gitignore — какие пути не добавлять в синхронизацию.\n# Пример: node_modules/\n# **/*.log\n" +
      "node_modules/\ndist/\nbuild/\n.next/\nout/\n*.min.js\n*.min.css\n.env*\n*.key\n*.pem\n*.p12\n*.pfx\n";
    // Offer to import from .gitignore
    let importContent = "";
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    try {
      await fs.access(gitignorePath);
      const answer = await vscode.window.showInformationMessage(
        "VSCodeSync: Импортировать паттерны из .gitignore в .vscodesync-ignore?",
        "Импортировать",
        "Пропустить",
      );
      if (answer === "Импортировать") {
        const raw = await fs.readFile(gitignorePath, "utf8");
        importContent = `# Импортировано из .gitignore\n${raw}\n\n`;
      }
    } catch {
      // No .gitignore
    }
    await fs.writeFile(fp, `${importContent}${defaultContent}`, "utf8");
    const suggested = await readEditorConfigSuggestedLineEnding(workspaceRoot);
    const curRaw = vscode.workspace.getConfiguration(CFG).get<string>("lineEnding", "lf");
    const normalizedCur = curRaw === "crlf" || curRaw === "preserve" ? curRaw : "lf";
    if (suggested !== null && normalizedCur !== "preserve" && suggested !== normalizedCur) {
      void vscode.window
        .showInformationMessage(
          `.editorconfig задаёт end_of_line (${suggested}). Чтобы канонический хэш совпадал между машинами, установите vscodesync.lineEnding «${suggested}» (сейчас «${normalizedCur}»).`,
          "Открыть настройки",
        )
        .then((sel) => {
          if (sel === "Открыть настройки") {
            void vscode.commands.executeCommand("workbench.action.openSettings", "vscodesync.lineEnding");
          }
        });
    }
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
  await vscode.window.showTextDocument(doc);
}

async function pickWorkspaceId(wc: Awaited<ReturnType<typeof WorkspaceConfigManager.load>>): Promise<string | undefined> {
  if (wc.activeWorkspaces.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
    return undefined;
  }
  if (wc.activeWorkspaces.length === 1) {
    return wc.activeWorkspaces[0]?.workspaceId;
  }
  const picked = await vscode.window.showQuickPick(
    wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, description: w.workspaceId, id: w.workspaceId })),
    { placeHolder: "Выберите workspace" },
  );
  return picked?.id;
}

async function saveLocalIgnorePatterns(workspaceRoot: string, workspaceId: string, lines: string[]): Promise<void> {
  const normalized = normalizeIgnorePatternStrings(lines);
  const cfg = await WorkspaceConfigManager.load(workspaceRoot);
  const ix = cfg.activeWorkspaces.findIndex((w) => w.workspaceId === workspaceId);
  if (ix < 0) {
    throw new Error("workspace not in config");
  }
  cfg.activeWorkspaces[ix] = {
    ...cfg.activeWorkspaces[ix],
    ignorePatterns: normalized.length > 0 ? normalized : undefined,
  };
  await WorkspaceConfigManager.save(cfg, workspaceRoot);
}

export interface EditWorkspaceIgnoreDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider?: () => Promise<ICloudProvider | null>;
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
}

/**
 * Palette: shared (manifest) / local (vscodesync.json) ignore patterns + open `.vscodesync-ignore`.
 * Priority at guard time: `.vscodesync-ignore` → shared → local.
 */
export async function runEditWorkspaceIgnorePatterns(deps: EditWorkspaceIgnoreDeps): Promise<void> {
  if (!(await assertWorkspaceTrusted())) {
    return;
  }
  const root = await resolveWorkspaceRootForPaletteCommand();
  if (!root) {
    await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
    return;
  }
  const wc = await WorkspaceConfigManager.load(root);

  const gate = await vscode.window.showQuickPick(
    [
      {
        label: "$(cloud) Общие паттерны (облако, все машины)",
        description: "sharedIgnorePatterns в `.vscodesync-workspace.json`",
        category: "shared" as const,
      },
      {
        label: "$(vm) Локальные паттерны (только эта машина)",
        description: "ignorePatterns в `.vscode/vscodesync.json`",
        category: "local" as const,
      },
      {
        label: "$(file) Файл .vscodesync-ignore",
        description: "Глобально для репозитория в проекте",
        category: "globalfile" as const,
      },
    ],
    { placeHolder: "VSCodeSync: правила исключения для трекинга" },
  );
  if (!gate || !("category" in gate)) {
    return;
  }

  if (gate.category === "globalfile") {
    await openGlobalVscodesyncIgnoreFile(root);
    return;
  }

  const workspaceId = await pickWorkspaceId(wc);
  if (!workspaceId) {
    return;
  }

  if (gate.category === "local") {
    const entry = wc.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    const initial = (entry?.ignorePatterns ?? []).join("\n");
    const edited = await vscode.window.showInputBox({
      title: "Локальные ignorePatterns (gitignore-синтаксис)",
      value: initial,
      prompt: "По одному паттерну на строку (только эта машина). Пусто — сбросить.",
      ignoreFocusOut: true,
    });
    if (edited === undefined) {
      return;
    }
    await saveLocalIgnorePatterns(
      root,
      workspaceId,
      normalizeIgnorePatternLinesFromText(edited),
    );
    void vscode.window.showInformationMessage("VSCodeSync: локальные ignorePatterns сохранены в vscodesync.json.");
    return;
  }

  const provider = await deps.tryAuthenticatedProvider?.();
  if (!provider) {
    await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
    return;
  }
  const gc = await deps.globalConfig.load();
  const engine = deps.makeEngine(root, provider, gc.machineId, gc.machineName, "user");
  const initialArr = await engine.readSharedIgnorePatterns(workspaceId);
  const edited = await vscode.window.showInputBox({
    title: "Общие sharedIgnorePatterns (облачный манифест)",
    value: initialArr.join("\n"),
    prompt: "По одному паттерну на строку. Синхронизируется между машинами.",
    ignoreFocusOut: true,
  });
  if (edited === undefined) {
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "VSCodeSync: запись shared ignore в облако…",
      cancellable: false,
    },
    async () => {
      await engine.setWorkspaceSharedIgnorePatterns(
        workspaceId,
        normalizeIgnorePatternLinesFromText(edited),
      );
    },
  );
  void vscode.window.showInformationMessage("VSCodeSync: shared ignore patterns обновлены в манифесте workspace.");
}
