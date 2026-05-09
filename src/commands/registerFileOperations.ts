/**
 * File-operations palette command bundle — tenth tranche of the
 * `extension.ts` decomposition (v2.6 in the roadmap).
 *
 * Holds the 12 commands that act on a single file (or a multi-select of
 * files) from the palette / Explorer / editor context: add, remove,
 * push, pull, move, diff, history, time-travel, open-in-cloud, pin.
 *
 * Same contract as the prior bundles. Heavy deps surface — expected for
 * the surface area covered.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { collectFilesToAddUnderRoots } from "../utils/syncAddCollect.js";
import { guardPathsBeforeAdd, guardPathsBeforePush } from "../ui/syncGuards.js";
import { pickWorkspaceId, pickOtherWorkspaceId } from "./_shared.js";
import { resolveFileTarget, resolveFileTargetLoose as resolveFileTargetLooseRaw } from "./_fileTargetHelpers.js";
import { openTrackedFileInCloudStorage, runShowFileHistory } from "./_engineFlows.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

async function runAddToNewWorkspaceImpl(
  globalConfig: GlobalConfigManager,
  runWithEngine: RunWithEngineFn,
  uri: vscode.Uri | undefined,
  allUris: vscode.Uri[] | undefined,
): Promise<void> {
  const selectedUris =
    Array.isArray(allUris) && allUris.length > 1
      ? allUris
      : uri
        ? [uri]
        : undefined;

  const target = await resolveFileTarget(selectedUris?.[0] ?? uri);
  if (!target) {
    return;
  }

  const underRoot = (p: string): boolean => {
    const rel = path.relative(target.root, p);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`);
  };

  const rawPaths: string[] = selectedUris
    ? selectedUris.map((u) => u.fsPath).filter((p) => underRoot(p))
    : [target.fsPath];

  const note =
    (await vscode.window.showInputBox({
      title: "VSCodeSync: новый workspace",
      prompt: "Будет создан воркспейс и в него добавлены выбранные файлы или содержимое папки",
      placeHolder: "Название / описание воркспейса",
    }))?.trim() ?? "";
  if (!note) {
    return;
  }

  await runWithEngine(async (engine, root, gc) => {
    const cfgProv = await gc.load();
    const t = cfgProv.activeProvider ?? "onedrive";
    try {
      const existing = await engine.listRemoteWorkspaceSummaries();
      const duplicate = existing.find(
        (w) => w.workspaceNote.trim().toLowerCase() === note.trim().toLowerCase(),
      );
      if (duplicate) {
        const proceed = await vscode.window.showWarningMessage(
          `VSCodeSync: workspace с названием «${duplicate.workspaceNote}» уже существует в облаке (${duplicate.workspaceId}). Создать ещё один?`,
          { modal: true },
          "Создать",
        );
        if (proceed !== "Создать") {
          return;
        }
      }
    } catch {
      /* non-fatal: listing may fail */
    }

    const wid = await engine.createWorkspace(note, t);
    const wc = await WorkspaceConfigManager.load(root);
    const ent = wc.activeWorkspaces.find((w) => w.workspaceId === wid);
    if (!ent) {
      throw new Error("VSCodeSync: запись workspace не найдена после создания");
    }
    const gconf = await gc.load();

    let selectionHadDirectory = false;
    for (const p of rawPaths) {
      try {
        const st = await fs.stat(p);
        if (st.isDirectory()) {
          selectionHadDirectory = true;
        }
      } catch {
        /* ignore */
      }
    }

    const expanded = await collectFilesToAddUnderRoots(target.root, rawPaths, {
      entry: ent,
      cfg: wc,
      machineName: gconf.machineName,
    });
    if (expanded.length === 0) {
      await vscode.window.showInformationMessage(
        `VSCodeSync: воркспейс «${note}» создан. Нечего добавить (пусто или всё в правилах исключения).`,
      );
      return;
    }
    if (expanded.length > 500) {
      const big = await vscode.window.showWarningMessage(
        `VSCodeSync: будет добавлено ${String(expanded.length)} файлов. Продолжить?`,
        { modal: true },
        "Продолжить",
      );
      if (big !== "Продолжить") {
        await vscode.window.showInformationMessage(
          `VSCodeSync: воркспейс «${note}» создан без файлов (операция отменена).`,
        );
        return;
      }
    }
    const useBulkAddConfirm = expanded.length > 1 || selectionHadDirectory;
    if (useBulkAddConfirm) {
      const ok = await vscode.window.showInformationMessage(
        `Новый воркспейс «${note}»: добавить ${String(expanded.length)} файл(ов) и синхронизировать?`,
        { modal: true },
        "Добавить",
      );
      if (ok !== "Добавить") {
        await vscode.window.showInformationMessage(
          `VSCodeSync: воркспейс «${note}» создан; файлы не добавлены.`,
        );
        return;
      }
    }
    const withPreview = !useBulkAddConfirm;
    if (
      !(await guardPathsBeforeAdd(expanded, withPreview, target.root, {
        entry: ent,
        cfg: wc,
        machineName: gconf.machineName,
      }))
    ) {
      await vscode.window.showInformationMessage(
        `VSCodeSync: воркспейс «${note}» создан; добавление файлов отменено.`,
      );
      return;
    }
    await engine.addFiles(wid, expanded);
    if (expanded.length === 1) {
      await vscode.window.showInformationMessage(`Воркспейс «${note}» создан; файл синхронизирован.`);
    } else {
      await vscode.window.showInformationMessage(
        `Воркспейс «${note}» создан; ${String(expanded.length)} файлов синхронизировано.`,
      );
    }
  }, target.root);
}

export interface FileOperationsCommandsDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  offlineQueueStore: SyncOfflineQueueStore;
  registry: ProviderRegistry;
  runWithEngine: RunWithEngineFn;
}

export function registerFileOperationsCommands(
  deps: FileOperationsCommandsDeps,
): vscode.Disposable[] {
  const {
    context,
    globalConfig,
    offlineQueueStore,
    registry,
    runWithEngine,
  } = deps;
  const resolveFileTargetLoose = (arg: unknown): Promise<{ root: string; fsPath: string } | undefined> =>
    resolveFileTargetLooseRaw(globalConfig, arg);
  const showFileHistoryAt = (target: { root: string; fsPath: string }): Promise<void> =>
    runShowFileHistory(runWithEngine, globalConfig, target);
  const openTrackedFileInCloudStorageAt = (target: { root: string; fsPath: string }): Promise<void> =>
    openTrackedFileInCloudStorage(registry, globalConfig, target);
  const runAddToNewWorkspace = (uri?: vscode.Uri, allUris?: vscode.Uri[]): Promise<void> =>
    runAddToNewWorkspaceImpl(globalConfig, runWithEngine, uri, allUris);

  return [
    vscode.commands.registerCommand("vscodesync.addCurrentFile", async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
      const selectedUris =
        Array.isArray(allUris) && allUris.length > 1
          ? allUris
          : uri
            ? [uri]
            : undefined;

      const target = await resolveFileTarget(selectedUris?.[0] ?? uri);
      if (!target) {
        return;
      }

      const underRoot = (p: string): boolean => {
        const rel = path.relative(target.root, p);
        return rel !== ".." && !rel.startsWith(`..${path.sep}`);
      };

      const rawPaths: string[] = selectedUris
        ? selectedUris.map((u) => u.fsPath).filter((p) => underRoot(p))
        : [target.fsPath];

      const ws = await pickWorkspaceId(target.root);
      if (!ws) {
        return;
      }
      const wc = await WorkspaceConfigManager.load(target.root);
      const ent = wc.activeWorkspaces.find((w) => w.workspaceId === ws);
      const gconf = await globalConfig.load();

      let selectionHadDirectory = false;
      for (const p of rawPaths) {
        try {
          const st = await fs.stat(p);
          if (st.isDirectory()) {
            selectionHadDirectory = true;
          }
        } catch {
          /* ignore missing */
        }
      }

      const expanded = await collectFilesToAddUnderRoots(target.root, rawPaths, {
        entry: ent,
        cfg: wc,
        machineName: gconf.machineName,
      });
      if (expanded.length === 0) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: нет файлов для добавления (пустая папка или все пути совпали с правилами исключения).",
        );
        return;
      }
      if (expanded.length > 500) {
        const big = await vscode.window.showWarningMessage(
          `VSCodeSync: будет добавлено ${String(expanded.length)} файлов. Продолжить?`,
          { modal: true },
          "Продолжить",
        );
        if (big !== "Продолжить") {
          return;
        }
      }
      const useBulkAddConfirm = expanded.length > 1 || selectionHadDirectory;
      if (useBulkAddConfirm) {
        const ok = await vscode.window.showInformationMessage(
          `Добавить в VSCodeSync ${String(expanded.length)} файл(ов) и синхронизировать?`,
          { modal: true },
          "Добавить",
        );
        if (ok !== "Добавить") {
          return;
        }
      }
      const withPreview = !useBulkAddConfirm;
      if (
        !(await guardPathsBeforeAdd(expanded, withPreview, target.root, {
          entry: ent,
          cfg: wc,
          machineName: gconf.machineName,
        }))
      ) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.addFiles(ws, expanded);
        if (expanded.length === 1) {
          await vscode.window.showInformationMessage("Файл добавлен и синхронизирован.");
        } else {
          await vscode.window.showInformationMessage(
            `${String(expanded.length)} файлов добавлено и синхронизировано.`,
          );
        }
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.addFolderToSync", async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
      await vscode.commands.executeCommand("vscodesync.addCurrentFile", uri, allUris);
    }),

    vscode.commands.registerCommand("vscodesync.addToNewWorkspace", runAddToNewWorkspace),

    vscode.commands.registerCommand("vscodesync.removeFromSync", async (arg?: unknown) => {
      const target = await resolveFileTargetLoose(arg);
      if (!target) {
        return;
      }
      const cfg = await WorkspaceConfigManager.load(target.root);
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const fileEntry = cfg.files.find((f) => f.localPath === rel);
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
        return;
      }
      const basename = path.basename(target.fsPath);
      type RemoveChoice = "cloud" | "local" | "all";
      const choice = await vscode.window.showWarningMessage(
        `Как убрать «${basename}» из VSCodeSync?`,
        { modal: true },
        "Удалить с облака",
        "Только отвязать здесь",
        "Убрать у всех машин",
      );
      if (!choice) {
        return;
      }
      const action: RemoveChoice =
        choice === "Удалить с облака"
          ? "cloud"
          : choice === "Только отвязать здесь"
            ? "local"
            : "all";
      await runWithEngine(async (engine) => {
        if (action === "cloud") {
          await engine.removeTrackedFiles(fileEntry.workspaceId, [target.fsPath]);
          await vscode.window.showInformationMessage("Файл убран из синхронизации и удалён с облака.");
        } else if (action === "local") {
          await engine.untrackFileLocal(fileEntry.workspaceId, [target.fsPath]);
          await vscode.window.showInformationMessage(
            "Файл отвязан на этой машине. В облаке и на других машинах остался.",
          );
        } else {
          await engine.untrackFileTombstoneOnly(fileEntry.workspaceId, [target.fsPath]);
          await vscode.window.showInformationMessage(
            "Файл убран у всех машин (tombstone). Blob в облаке не удалён.",
          );
        }
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.pushCurrentFile", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const abs = path.join(target.root, ...rel.split("/"));
      if (!(await guardPathsBeforePush([abs]))) {
        return;
      }
      await runWithEngine(async (engine, root) => {
        const cfg = await WorkspaceConfigManager.load(root);
        const fileEntry = cfg.files.find((f) => f.localPath === rel);
        if (!fileEntry) {
          await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
          return;
        }
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === fileEntry.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден в конфиге.");
          return;
        }
        await engine.pushFile(cfg, fileEntry.workspaceId, rel, entry);
        await vscode.window.showInformationMessage(`Push ${rel}: готово.`);
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.pullCurrentFile", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      await runWithEngine(async (engine, root) => {
        const cfg = await WorkspaceConfigManager.load(root);
        const fileEntry = cfg.files.find((f) => f.localPath === rel);
        if (!fileEntry) {
          await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
          return;
        }
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === fileEntry.workspaceId);
        if (!entry) {
          await vscode.window.showErrorMessage("VSCodeSync: workspace не найден в конфиге.");
          return;
        }
        const result = await engine.pullFile(cfg, fileEntry.workspaceId, rel, entry);
        if (result === "already_current") {
          await vscode.window.showInformationMessage(`${rel}: уже актуален.`);
        } else {
          await vscode.window.showInformationMessage(`Pull ${rel}: готово.`);
        }
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.moveCurrentFileToWorkspace", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg0 = await WorkspaceConfigManager.load(target.root);
      const fileEntry = cfg0.files.find((f) => f.localPath === rel);
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
        return;
      }
      const toWs = await pickOtherWorkspaceId(target.root, fileEntry.workspaceId);
      if (!toWs) {
        return;
      }
      const fromWs = fileEntry.workspaceId;
      const gconf = await globalConfig.load();
      const ent = cfg0.activeWorkspaces.find((w) => w.workspaceId === toWs);
      if (
        !(await guardPathsBeforeAdd([target.fsPath], false, target.root, {
          entry: ent,
          cfg: cfg0,
          machineName: gconf.machineName,
        }))
      ) {
        return;
      }
      await runWithEngine(async (engine) => {
        await engine.removeTrackedFiles(fromWs, [target.fsPath]);
        await engine.addFiles(toWs, [target.fsPath]);
        await vscode.window.showInformationMessage("Файл перемещён в другой workspace.");
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.diffWithCloud", async (arg?: unknown) => {
      const target = await resolveFileTargetLoose(arg);
      if (!target) {
        return;
      }
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg0 = await WorkspaceConfigManager.load(target.root);
      if (!cfg0.files.some((f) => f.localPath === rel)) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
        return;
      }
      await runWithEngine(
        async (engine) => {
          const { body } = await engine.downloadTrackedBlob(rel);
          const tmp = path.join(
            os.tmpdir(),
            `vscodesync-cloud-${String(Date.now())}-${path.basename(target.fsPath)}`,
          );
          await fs.writeFile(tmp, body);
          const right = vscode.Uri.file(tmp);
          const left = vscode.Uri.file(target.fsPath);
          const title = `${path.basename(target.fsPath)} (локально ↔ облако)`;
          await vscode.commands.executeCommand("vscode.diff", left, right, title);
        },
        target.root,
      );
    }),

    vscode.commands.registerCommand("vscodesync.showFileHistory", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      await showFileHistoryAt(target);
    }),

    vscode.commands.registerCommand("vscodesync.openTimeTravelScrubber", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) return;
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
      const cfg = await WorkspaceConfigManager.load(target.root);
      const row = cfg.files.find((f) => f.localPath === rel);
      if (!row) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не отслеживается этим расширением.");
        return;
      }
      await runWithEngine(async (engine) => {
        const provider = engine.deps.provider;
        const { openTimeTravelScrubber } = await import("../ui/timeTravelScrubberPanel.js");
        await openTimeTravelScrubber({
          context,
          provider,
          workspaceId: row.workspaceId,
          relPath: rel,
        });
      }, target.root);
    }),

    vscode.commands.registerCommand("vscodesync.openInCloudStorage", async (uri?: vscode.Uri) => {
      const target = await resolveFileTarget(uri);
      if (!target) {
        return;
      }
      await openTrackedFileInCloudStorageAt(target);
    }),

    vscode.commands.registerCommand("vscodesync.pinFileForSync", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme !== "file") {
        await vscode.window.showWarningMessage("VSCodeSync: откройте файл для pin.");
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (!folder) return;
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      const rel = path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join("/");
      const tf = wc.files.find((f) => f.localPath === rel);
      if (!tf) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: файл не отслеживается — добавьте его в workspace.",
        );
        return;
      }
      await offlineQueueStore.enqueuePush(folder.uri.fsPath, rel, tf.workspaceId, true);
      await vscode.window.showInformationMessage(
        `VSCodeSync: «${rel}» закреплён в начале очереди — выгрузится первым при следующем flush.`,
      );
    }),
  ];
}
