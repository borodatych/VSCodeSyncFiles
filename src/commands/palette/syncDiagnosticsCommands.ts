/**
 * Sync diagnostics — palette commands.
 *
 * Диагностика: запись сессии синка, сверка манифеста, принудительный pull с машины, поиск осиротевших записей.
 *
 * Вынесено из `ui/plannedPaletteCommands.ts` (F12): 27 команд из семи доменов
 * жили в одном файле на 1115 строк, и добавление любой новой команды делало
 * его ещё менее читаемым.
 */
import * as vscode from "vscode";
import { resolveWorkspaceRootForPaletteCommand } from "../../utils/workspaceRootResolver.js";
import { WorkspaceConfigManager } from "../../core/workspaceConfigManager.js";
import type { PaletteExtras } from "./_shared.js";

export function registerSyncDiagnosticsCommands(
  context: vscode.ExtensionContext,
  extras: PaletteExtras,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.startSyncRecording", async () => {
      const { startRecording, isRecording } = await import("../../ui/syncReplayRecorderState.js");
      if (isRecording()) {
        void vscode.window.showInformationMessage("VSCodeSync: запись уже идёт. Stop, чтобы остановить.");
        return;
      }
      const gc = await extras.globalConfig.load();
      const { sessionId } = startRecording(extras.globalConfig.getStorageDir(), gc.machineName);
      void vscode.window.showInformationMessage(
        `VSCodeSync: запись sync-сессии началась (id: ${sessionId.slice(0, 8)}…).`,
      );
    }),
    vscode.commands.registerCommand("vscodesync.stopSyncRecording", async () => {
      const { stopRecording, isRecording } = await import("../../ui/syncReplayRecorderState.js");
      if (!isRecording()) {
        void vscode.window.showInformationMessage("VSCodeSync: нет активной записи.");
        return;
      }
      const fp = await stopRecording();
      if (!fp) {
        await vscode.window.showWarningMessage("VSCodeSync: не удалось сохранить запись.");
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `VSCodeSync: запись сохранена в ${fp}.`,
        "Открыть",
      );
      if (choice === "Открыть") {
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(fp));
      }
    }),
    vscode.commands.registerCommand("vscodesync.diffWorkspaceManifest", async () => {
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
        return;
      }
      const { WorkspaceConfigManager: WCM } = await import("../../core/workspaceConfigManager.js");
      const wc = await WCM.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }
      const picked = wc.activeWorkspaces.length === 1
        ? wc.activeWorkspaces[0]
        : await vscode.window.showQuickPick(
            wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, description: w.workspaceId, w })),
            { placeHolder: "Workspace для сравнения" },
          ).then((p) => p?.w);
      if (!picked) return;

      const { manifestCloudPath } = await import("../../core/cloudLayout.js");
      const dl = await provider.downloadFile(manifestCloudPath(picked.workspaceId)).catch(() => null);
      if (!dl) {
        await vscode.window.showWarningMessage("VSCodeSync: облачный манифест недоступен.");
        return;
      }
      interface CloudFile { path: string; removedAt?: string }
      interface CloudManifestLite { files: CloudFile[] }
      const remote = JSON.parse(dl.body.toString("utf8")) as CloudManifestLite;
      const remoteSet = new Set(remote.files.filter((f) => !f.removedAt).map((f) => f.path));
      const localSet = new Set(
        wc.files.filter((f) => f.workspaceId === picked.workspaceId).map((f) => f.localPath),
      );
      const onlyLocal = [...localSet].filter((p) => !remoteSet.has(p)).sort();
      const onlyRemote = [...remoteSet].filter((p) => !localSet.has(p)).sort();
      const both = [...localSet].filter((p) => remoteSet.has(p)).sort();

      const channel = vscode.window.createOutputChannel(`VSCodeSync · diff ${picked.workspaceNote}`);
      channel.appendLine(`Workspace: ${picked.workspaceNote} (${picked.workspaceId})`);
      channel.appendLine("");
      channel.appendLine(`✅ В обоих (${String(both.length)}):`);
      for (const p of both) channel.appendLine(`  ${p}`);
      channel.appendLine("");
      channel.appendLine(`⚠ Только локально, нет в облаке (${String(onlyLocal.length)}):`);
      for (const p of onlyLocal) channel.appendLine(`  ${p}`);
      channel.appendLine("");
      channel.appendLine(`⚠ Только в облаке, нет локально (${String(onlyRemote.length)}):`);
      for (const p of onlyRemote) channel.appendLine(`  ${p}`);
      channel.show();
    }),

    vscode.commands.registerCommand("vscodesync.forcePullFromMachine", async () => {
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активного файла.");
        return;
      }
      const { WorkspaceConfigManager: WCM } = await import("../../core/workspaceConfigManager.js");
      const wc = await WCM.load(root);
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false).split("\\").join("/");
      const tf = wc.files.find((f) => f.localPath === rel);
      if (!tf) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: текущий файл не отслеживается — добавьте его сначала.",
        );
        return;
      }
      // Reuse showFileHistory which already lists machine versions from .history/.
      await vscode.commands.executeCommand("vscodesync.showFileHistory", editor.document.uri);
    }),

    vscode.commands.registerCommand("vscodesync.detectGarbageTracked", async () => {
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(root);
      if (wc.activeWorkspaces.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: нет привязанных workspace'ов.");
        return;
      }
      // Build samples from manifest paths + activity push counts (last 30 days).
      const { loadActivityFile } = await import("../../core/activityLog.js");
      const file = await loadActivityFile(extras.globalConfig.getStorageDir());
      const cutoff = Date.now() - 30 * 86_400_000;
      const pushes = new Map<string, number>();
      for (const ev of file.events) {
        if (ev.kind !== "push") continue;
        const t = Date.parse(ev.at);
        if (!Number.isFinite(t) || t < cutoff) continue;
        pushes.set(ev.relPath, (pushes.get(ev.relPath) ?? 0) + 1);
      }
      interface FS { path: string; pushCount: number; sizeBytes?: number }
      const samples: FS[] = wc.files.map((f) => ({
        path: f.localPath,
        pushCount: pushes.get(f.localPath) ?? 0,
      }));
      const { rankGarbageCandidates, suggestIgnorePatterns } = await import("../../core/aiGarbageTrackedDetector.js");
      const candidates = rankGarbageCandidates(samples);
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: подозрительных tracked-файлов не найдено.");
        return;
      }
      const channel = vscode.window.createOutputChannel("VSCodeSync · garbage detector");
      channel.clear();
      channel.appendLine(`Кандидаты на вынос в .vscodesync.ignore (${String(candidates.length)}):`);
      channel.appendLine("");
      for (const c of candidates) {
        channel.appendLine(`  [${c.score.toFixed(2)}] ${c.path}  ←  ${c.reasons.join(", ")}`);
      }
      const patterns = suggestIgnorePatterns(candidates);
      channel.appendLine("");
      channel.appendLine("Предлагаемые ignore-паттерны:");
      for (const p of patterns) channel.appendLine(`  ${p}`);
      channel.show(true);
      const choice = await vscode.window.showInformationMessage(
        `VSCodeSync: найдено ${String(candidates.length)} кандидатов. Скопировать ignore-паттерны в clipboard?`,
        "Скопировать",
        "Закрыть",
      );
      if (choice === "Скопировать") {
        await vscode.env.clipboard.writeText(patterns.join("\n"));
        void vscode.window.showInformationMessage("VSCodeSync: паттерны скопированы в clipboard.");
      }
    }),
  );
}
