/**
 * Engine-flow helpers — single-shot operations that combine
 * `runWithEngine` with download/diff/AI-merge orchestration.
 *
 * Lifted out of extension.ts as part of v2.6.7 (extension.ts < 500 LoC
 * goal). All take their deps as args; no closures over activate scope.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { absoluteToTrackedPosix } from "../core/pathMapping.js";
import { runAiMerge } from "../core/aiMerge.js";
import { aiMergePreviewPath, summarizeAiMergeDiff } from "../core/aiMergePlan.js";
import { backupExistingUserFile } from "../core/localFileBackup.js";
import { writeFileAtomic } from "../core/writeTextFileAtomic.js";
import { readLocalBackupSettings } from "../ui/localBackupSettings.js";
import { keepMineWithCloudMovedPrompt } from "../ui/conflictKeepMinePrompt.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ensureProvider } from "./_providerFactory.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

function historyVersionLabel(meta: { cloudPath: string; modifiedIso?: string }): string {
  if (meta.modifiedIso) {
    try {
      return new Date(meta.modifiedIso).toLocaleString(vscode.env.language);
    } catch {
      /* ignore */
    }
  }
  const i = meta.cloudPath.lastIndexOf("/");
  return i >= 0 ? meta.cloudPath.slice(i + 1) : meta.cloudPath;
}

/** Show a QuickPick of cloud-history snapshots + local backups for a tracked
 * file. Each pick offers Open / Diff against the current local version. */
export async function runShowFileHistory(
  runWithEngine: RunWithEngineFn,
  globalConfig: GlobalConfigManager,
  target: { root: string; fsPath: string },
): Promise<void> {
  const gc = await globalConfig.load();
  const cfg0 = await WorkspaceConfigManager.load(target.root);
  let rel: string;
  try {
    rel = absoluteToTrackedPosix(target.root, cfg0.pathMapping, gc.machineName, target.fsPath);
  } catch {
    await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
    return;
  }
  if (!cfg0.files.some((f) => f.localPath === rel)) {
    await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
    return;
  }
  await runWithEngine(async (engine) => {
    const items = await engine.listCloudHistoryForTrackedFile(rel);
    const localBackupDir = path.join(target.root, ".vscode", "vscodesync-local-backup");
    const localBackups: { label: string; fsPath: string }[] = [];
    try {
      const timestamps = await fs.readdir(localBackupDir);
      for (const ts of timestamps.sort().reverse()) {
        const backupPath = path.join(localBackupDir, ts, ...rel.split("/"));
        try {
          await fs.access(backupPath);
          const dateStr = ts.replace(/T/, " ").replace(/\.\d+Z/, "").replace(/-/g, "/").replace(/\//g, "/");
          localBackups.push({ label: `📁 local backup · ${dateStr}`, fsPath: backupPath });
        } catch {
          /* backup doesn't include this file */
        }
      }
    } catch {
      /* no backup dir */
    }

    if (items.length === 0 && localBackups.length === 0) {
      void vscode.window.showInformationMessage(
        "VSCodeSync: в облаке нет снимков истории для этого файла. Они появляются после успешного push.",
      );
      return;
    }
    type HistPick = vscode.QuickPickItem & { cloudPath?: string; localFsPath?: string };
    const cloudItems: HistPick[] = items.map((m) => ({
      label: historyVersionLabel(m),
      description: m.cloudPath.includes("/") ? m.cloudPath.split("/").pop() : m.cloudPath,
      cloudPath: m.cloudPath,
    }));
    const localItems: HistPick[] = localBackups.map((b) => ({
      label: b.label,
      localFsPath: b.fsPath,
    }));
    const picked = await vscode.window.showQuickPick<HistPick>(
      [...localItems, ...cloudItems],
      { placeHolder: "Версия файла (local backup / облачная история)" },
    );
    if (!picked) {
      return;
    }
    const action = await vscode.window.showQuickPick(
      [
        { label: "Открыть", value: "open" as const },
        { label: "Сравнить с локальным файлом", value: "diff" as const },
      ],
      { placeHolder: "Действие" },
    );
    if (!action) {
      return;
    }
    let tmpUri: vscode.Uri;
    if (picked.localFsPath) {
      tmpUri = vscode.Uri.file(picked.localFsPath);
    } else if (picked.cloudPath) {
      const body = await engine.downloadHistorySnapshotIfOwned(rel, picked.cloudPath);
      const tmp = path.join(
        os.tmpdir(),
        `vscodesync-history-${String(Date.now())}-${path.basename(target.fsPath)}`,
      );
      await fs.writeFile(tmp, body);
      tmpUri = vscode.Uri.file(tmp);
    } else {
      return;
    }
    const localUri = vscode.Uri.file(target.fsPath);
    if (action.value === "open") {
      await vscode.window.showTextDocument(tmpUri);
    } else {
      const title = `${path.basename(target.fsPath)} (локально ↔ история)`;
      await vscode.commands.executeCommand("vscode.diff", localUri, tmpUri, title);
    }
  }, target.root);
}

/**
 * 3-way conflict diff:
 * - Downloads latest `.history/` version as `base` (common ancestor)
 * - Downloads current cloud version as `remote`
 * - Opens two diffs: base↔local ("your changes") and base↔remote ("cloud changes")
 * - If no history: falls back to 2-way diff local↔cloud
 */
export async function runConflict3WayDiff(
  runWithEngine: RunWithEngineFn,
  target: { root: string; fsPath: string },
): Promise<void> {
  await runWithEngine(async (engine) => {
    const basename = path.basename(target.fsPath);
    const posixRel = path.relative(target.root, target.fsPath).split(path.sep).join("/");
    const localUri = vscode.Uri.file(target.fsPath);

    let remoteTmp: string | undefined;
    try {
      const { body } = await engine.downloadTrackedBlob(posixRel);
      remoteTmp = path.join(os.tmpdir(), `vscodesync-remote-${String(Date.now())}-${basename}`);
      await fs.writeFile(remoteTmp, body);
    } catch {
      /* fallback: can't get cloud version */
    }

    let baseTmp: string | undefined;
    try {
      const histItems = await engine.listCloudHistoryForTrackedFile(posixRel);
      if (histItems.length > 0 && histItems[0]) {
        const baseBody = await engine.downloadHistorySnapshotIfOwned(posixRel, histItems[0].cloudPath);
        baseTmp = path.join(os.tmpdir(), `vscodesync-base-${String(Date.now())}-${basename}`);
        await fs.writeFile(baseTmp, baseBody);
      }
    } catch {
      /* No history available */
    }

    if (baseTmp && remoteTmp) {
      const baseUri = vscode.Uri.file(baseTmp);
      const remoteUri = vscode.Uri.file(remoteTmp);
      await vscode.commands.executeCommand(
        "vscode.diff",
        baseUri,
        localUri,
        `${basename}: ваши изменения (история → локально)`,
      );
      await vscode.commands.executeCommand(
        "vscode.diff",
        baseUri,
        remoteUri,
        `${basename}: облачные изменения (история → облако)`,
        { viewColumn: vscode.ViewColumn.Beside },
      );
      void vscode.window.showInformationMessage(
        `VSCodeSync: слева — ваши изменения (история → локально), справа — облачные изменения (история → облако). Используйте Keep Mine или Take Theirs для разрешения.`,
      );
    } else if (remoteTmp) {
      const remoteUri = vscode.Uri.file(remoteTmp);
      await vscode.commands.executeCommand(
        "vscode.diff",
        localUri,
        remoteUri,
        `${basename}: локально ↔ облако`,
      );
      void vscode.window.showInformationMessage(
        `VSCodeSync: история недоступна — показан 2-way diff. Используйте Keep Mine или Take Theirs.`,
      );
    } else {
      await vscode.commands.executeCommand("vscodesync.diffWithCloud", localUri);
    }
  }, target.root);
}

/**
 * AI-assisted merge for a conflicting file.
 * 1. Downloads remote (cloud) version.
 * 2. Gets base from .history/ (common ancestor).
 * 3. Reads local version from disk.
 * 4. Calls runAiMerge; the answer is staged to a preview file, shown as a diff
 *    against the local version and applied only on explicit confirmation, with
 *    the pre-merge local file copied into the backup dir first (D5).
 * 5. Pushing the result is a separate question — merging is not publishing.
 * Returns true when the conflict was resolved, false when skipped/failed.
 */
export async function runAiMergeForConflict(
  runWithEngine: RunWithEngineFn,
  target: { root: string; fsPath: string },
  workspaceId: string,
  posixRel: string,
  notifiedConflictKeys: Set<string>,
): Promise<boolean> {
  let resolved = false;

  await runWithEngine(async (engine) => {
    const basename = path.basename(target.fsPath);

    let remoteText: string | undefined;
    try {
      const { body } = await engine.downloadTrackedBlob(posixRel);
      remoteText = body.toString("utf8");
    } catch {
      await vscode.window.showWarningMessage(
        "VSCodeSync AI Merge: не удалось скачать облачную версию.",
      );
      return;
    }

    let localText: string;
    try {
      localText = await fs.readFile(target.fsPath, "utf8");
    } catch {
      await vscode.window.showWarningMessage(
        "VSCodeSync AI Merge: не удалось прочитать локальный файл.",
      );
      return;
    }

    let baseText = "";
    try {
      const histItems = await engine.listCloudHistoryForTrackedFile(posixRel);
      if (histItems.length > 0 && histItems[0]) {
        const baseBody = await engine.downloadHistorySnapshotIfOwned(posixRel, histItems[0].cloudPath);
        baseText = baseBody.toString("utf8");
      }
    } catch {
      /* history unavailable — use empty base (effectively 2-way merge) */
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `VSCodeSync: AI merge «${basename}»…`, cancellable: false },
      async () => runAiMerge(baseText, localText, remoteText, posixRel),
    );

    if (!result.ok) {
      const reasonMsg: Record<string, string> = {
        disabled: "AI merge отключён (vscodesync.aiMerge.enabled: false).",
        no_model: "Нет доступной языковой модели. Активируйте GitHub Copilot.",
        too_large: result.detail ?? "Файл слишком большой для AI merge.",
        model_refused: result.detail ?? "Модель не смогла разрешить конфликт. Разрешите вручную.",
        error: result.detail ?? "Ошибка AI merge.",
      };
      await vscode.window.showWarningMessage(`VSCodeSync AI Merge: ${reasonMsg[result.reason]}`);
      return;
    }

    const summary = summarizeAiMergeDiff(localText, result.merged);
    if (summary.identical) {
      await vscode.window.showInformationMessage(
        `VSCodeSync AI Merge: модель вернула локальную версию без изменений — конфликт «${basename}» не тронут.`,
      );
      return;
    }

    // Stage the model's answer and let the user look at it before it becomes
    // their file. Nothing on disk changes until "Применить".
    const backupCfg = readLocalBackupSettings(target.root);
    const previewPath = aiMergePreviewPath(
      target.root,
      backupCfg.backupDir,
      posixRel,
      Date.now(),
    );
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    await fs.writeFile(previewPath, result.merged, "utf8");
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(target.fsPath),
      vscode.Uri.file(previewPath),
      `${basename}: локальная ↔ AI merge`,
    );

    const apply = await vscode.window.showInformationMessage(
      `VSCodeSync AI Merge «${basename}»: +${String(summary.addedLines)} / −${String(summary.removedLines)} строк. Применить результат к локальному файлу?`,
      { modal: true },
      "Применить",
    );
    if (apply !== "Применить") {
      void vscode.window.showInformationMessage(
        `VSCodeSync AI Merge: отклонено. Результат остался в ${path.relative(target.root, previewPath)}.`,
      );
      return;
    }

    if (backupCfg.enabled) {
      await backupExistingUserFile({
        absPath: target.fsPath,
        workspaceRoot: target.root,
        posixRel,
        retentionDays: backupCfg.retentionDays,
        backupDir: backupCfg.backupDir,
      });
    }
    await writeFileAtomic(target.fsPath, result.merged);
    await fs.rm(previewPath, { force: true });
    resolved = true;

    // Merging and publishing are separate decisions: the merged file may still
    // need a human pass before the other machines see it.
    const push = await vscode.window.showInformationMessage(
      `✨ VSCodeSync: «${basename}» смёржен локально. Отправить эту версию в облако и снять конфликт?`,
      { modal: true },
      "Отправить",
      "Позже",
    );
    if (push !== "Отправить") {
      return;
    }
    const pushed = await keepMineWithCloudMovedPrompt(
      (opts) => engine.resolveConflictKeepMine(workspaceId, posixRel, opts),
      posixRel,
    );
    if (pushed) {
      notifiedConflictKeys.delete(`${workspaceId}:${posixRel}`);
      void vscode.window.showInformationMessage(
        `✨ VSCodeSync: конфликт «${basename}» разрешён — версия отправлена в облако.`,
      );
    }
  }, target.root);

  return resolved;
}

/** Open the cloud-side web view of a tracked file via provider's
 * `getWebViewLink`. No-op if the active provider doesn't support it. */
export async function openTrackedFileInCloudStorage(
  registry: ProviderRegistry,
  globalConfig: GlobalConfigManager,
  target: { root: string; fsPath: string },
): Promise<void> {
  const gc = await globalConfig.load();
  const cfg0 = await WorkspaceConfigManager.load(target.root);
  let rel: string;
  try {
    rel = absoluteToTrackedPosix(target.root, cfg0.pathMapping, gc.machineName, target.fsPath);
  } catch {
    await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
    return;
  }
  const fileEntry = cfg0.files.find((f) => f.localPath === rel);
  if (!fileEntry) {
    await vscode.window.showWarningMessage("VSCodeSync: файл не в синхронизации.");
    return;
  }
  const provider = await ensureProvider(registry, globalConfig);
  if (!provider) {
    return;
  }
  if (!provider.getWebViewLink) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: веб-ссылка для этого провайдера не поддерживается.",
    );
    return;
  }
  try {
    const url = await provider.getWebViewLink(fileEntry.cloudPath);
    if (!url) {
      await vscode.window.showWarningMessage("VSCodeSync: файл не найден в облаке или ссылка недоступна.");
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(`VSCodeSync: не удалось открыть облако — ${msg}`);
  }
}
