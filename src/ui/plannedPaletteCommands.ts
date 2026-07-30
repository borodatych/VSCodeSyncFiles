import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GlobalConfigManager } from "../core/globalConfigManager.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import {
  exportWorkspaceStructure,
  exportWorkspaceStructureFullCache,
  importWorkspaceStructure,
} from "./workspaceStructureBackup.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";
import {
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
} from "../core/snapshotsEngine.js";
import { planSnapshotRetention } from "../core/snapshotRetentionPlan.js";
import { exportKeyWithPassword, importKeyWithPassword, generateEncryptionKey, encryptBuffer, decryptBuffer } from "../core/encryption.js";
import { readEncryptionKey, storeEncryptionKey } from "../core/encryptionKey.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { WorkspacesTreeProvider } from "./workspacesTree.js";
import { runConfigurePathMapping } from "./configurePathMapping.js";
import { runEditWorkspaceIgnorePatterns } from "./workspaceIgnorePatternsUi.js";
import { runMergeWorkspaces } from "./mergeWorkspacesWizard.js";
import { openActivityFeedPanel } from "./activityFeedPanel.js";
import { setLastAppliedFilter } from "./activitySavedSearches.js";
import { openStatsDashboardPanel } from "./statsDashboardPanel.js";
import { resolveWorkspaceRootForPaletteCommand } from "../utils/workspaceRootResolver.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";

const CFG = "vscodesync";


/** Расширение для `registerPlannedPaletteCommands`: глобальный конфиг + обновление UI после локальных изменений. */
export interface PlannedPaletteExtras {
  globalConfig: GlobalConfigManager;
  /** Build engine (shared ignore, snapshots, …). */
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
  refreshAfterLocalConfigChange?: () => void | Promise<void>;
  /** After global session pause ends: preview plan + optional full sync. */
  runAfterSessionResume?: () => void | Promise<void>;
  /** For snapshot commands — authenticated provider. */
  tryAuthenticatedProvider?: () => Promise<ICloudProvider | null>;
  workspacesTree?: WorkspacesTreeProvider;
  /** For encryption key commands — VSCode SecretStorage. */
  secrets?: import("vscode").SecretStorage;
}

/** Команды из docs/v1/03-ui/roadmap.md §3.3 без полной реализации — palette + заглушка или минимальный UX. */
export function registerPlannedPaletteCommands(
  context: vscode.ExtensionContext,
  extras: PlannedPaletteExtras,
): void {
  const configuration = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(CFG);

  const refreshGlobal = async (): Promise<void> => {
    await extras.refreshAfterLocalConfigChange?.();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.togglePause", async () => {
      const next = !syncSessionPause.isPaused();
      syncSessionPause.setPaused(next);
      if (!next) {
        await extras.runAfterSessionResume?.();
      }
      await refreshGlobal();
      if (next) {
        void vscode.window.showInformationMessage(
          "VSCodeSync: пауза (только эта сессия). Автосинхронизация отключена; ручные Push/Pull и Quick Transfer доступны.",
        );
      }
    }),
    vscode.commands.registerCommand("vscodesync.resume", async () => {
      if (!syncSessionPause.isPaused()) {
        await refreshGlobal();
        return;
      }
      syncSessionPause.setPaused(false);
      await extras.runAfterSessionResume?.();
      await refreshGlobal();
      void vscode.window.showInformationMessage("VSCodeSync: Resume — пауза снята.");
    }),
    vscode.commands.registerCommand("vscodesync.enableWatchMode", async () => {
      await configuration().update("watchMode", true, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        "VSCodeSync: watchMode включён — фоновый полный sync по интервалу (см. watchIntervalSeconds); на глобальной паузе опрос останавливается.",
      );
    }),
    vscode.commands.registerCommand("vscodesync.createSnapshot", async () => {
      if (!(await assertWorkspaceTrusted())) {
        return;
      }
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
      const gc = await extras.globalConfig.load();
      const { WorkspaceConfigManager: WCM } = await import("../core/workspaceConfigManager.js");
      const wc = await WCM.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }

      let workspaceId: string | undefined;
      if (wc.activeWorkspaces.length === 1) {
        workspaceId = wc.activeWorkspaces[0]?.workspaceId;
      } else {
        const picked = await vscode.window.showQuickPick(
          wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, id: w.workspaceId })),
          { placeHolder: "Workspace для снапшота" },
        );
        workspaceId = picked?.id;
      }
      if (!workspaceId) {
        return;
      }

      // AI prefill (best-effort): if vscode.lm is available and aiMerge is on,
      // suggest a Conventional-Commit one-liner from the workspace's tracked files.
      // Falls back to empty placeholder when LM isn't available.
      let aiPrefill = "";
      const aiOn = configuration().get<boolean>("aiMerge.enabled", false);
      if (aiOn) {
        try {
          const targetWs = wc.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
          const files = wc.files
            .filter((f) => f.workspaceId === workspaceId)
            .map((f) => f.localPath);
          const { suggestCommitMessage } = await import("../core/aiCommitMessage.js");
          const suggestion = await suggestCommitMessage({
            workspaceNote: targetWs?.workspaceNote ?? "",
            changedFiles: files,
            intent: "snapshot",
          });
          if (suggestion.ok) aiPrefill = suggestion.message;
        } catch {
          /* AI is opt-in; ignore failures silently */
        }
      }

      const nameInput = await vscode.window.showInputBox({
        prompt: "Имя снапшота (например: перед деплоем)",
        placeHolder: "snapshot-name",
        value: aiPrefill,
      });
      if (!nameInput?.trim()) {
        return;
      }

      const wsId = workspaceId;
      const conf = configuration();
      const retentionDays = conf.get<number>("snapshotRetentionDays", 180);
      const maxPerWorkspace = conf.get<number>("maxSnapshotsPerWorkspace", 20);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: создание снапшота…", cancellable: false },
        async () => {
          const finalName = await createWorkspaceSnapshot(provider, root, wsId, nameInput, gc.machineName);
          void vscode.window.showInformationMessage(`VSCodeSync: снапшот «${finalName}» создан.`);
          try {
            const snapshots = await listWorkspaceSnapshots(provider, wsId);
            const plan = planSnapshotRetention({ snapshots, retentionDays, maxPerWorkspace });
            for (const s of plan.delete) {
              await deleteWorkspaceSnapshot(provider, wsId, s.name);
            }
          } catch {
            /* retention is best-effort — never fail the create itself */
          }
        },
      );
    }),

    vscode.commands.registerCommand("vscodesync.restoreSnapshot", async () => {
      if (!(await assertWorkspaceTrusted())) {
        return;
      }
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
      const gc = await extras.globalConfig.load();
      const { WorkspaceConfigManager: WCM } = await import("../core/workspaceConfigManager.js");
      const wc = await WCM.load(root);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет активных workspace.");
        return;
      }

      let workspaceId: string | undefined;
      if (wc.activeWorkspaces.length === 1) {
        workspaceId = wc.activeWorkspaces[0]?.workspaceId;
      } else {
        const picked = await vscode.window.showQuickPick(
          wc.activeWorkspaces.map((w) => ({ label: w.workspaceNote, id: w.workspaceId })),
          { placeHolder: "Workspace для восстановления" },
        );
        workspaceId = picked?.id;
      }
      if (!workspaceId) {
        return;
      }

      const snapshots = await listWorkspaceSnapshots(provider, workspaceId);
      if (snapshots.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: снапшотов не найдено.");
        return;
      }

      const items = snapshots.map((s) => ({
        label: s.meta.name,
        description: `${s.category === "system" ? "🔒 Системный" : "Пользовательский"} · ${new Date(s.meta.createdAt).toLocaleString(vscode.env.language)} · ${String(s.meta.files.length)} файлов`,
        name: s.name,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Выберите снапшот для восстановления",
      });
      if (!picked) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Восстановить снапшот «${picked.label}»? Перед восстановлением будет создан авто-снапшот. Текущие локальные файлы будут перезаписаны.`,
        { modal: true },
        "Восстановить",
      );
      if (confirm !== "Восстановить") {
        return;
      }

      const wsIdRestore = workspaceId;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: восстановление снапшота…", cancellable: false },
        async (progress) => {
          progress.report({ message: "Создание авто-снапшота…" });
          await createWorkspaceSnapshot(
            provider,
            root,
            wsIdRestore,
            `auto-pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`,
            gc.machineName,
          );
          progress.report({ message: "Восстановление файлов…" });
          const result = await restoreWorkspaceSnapshot(provider, root, wsIdRestore, picked.name, gc.machineName);
          void vscode.window.showInformationMessage(
            `VSCodeSync: восстановлено ${String(result.restoredCount)} файлов из снапшота «${picked.label}».`,
          );
        },
      );
    }),
    vscode.commands.registerCommand("vscodesync.disableWatchMode", async () => {
      await configuration().update("watchMode", false, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage("VSCodeSync: watchMode выключен.");
    }),
    vscode.commands.registerCommand("vscodesync.toggleWatchMode", async () => {
      const cfg = configuration();
      const next = !cfg.get<boolean>("watchMode", false);
      await cfg.update("watchMode", next, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`VSCodeSync: watchMode — ${next ? "вкл" : "выкл"}.`);
    }),
    vscode.commands.registerCommand("vscodesync.openStats", () => {
      openStatsDashboardPanel(context, extras.globalConfig.getStorageDir());
    }),
    vscode.commands.registerCommand("vscodesync.openActivityFeed", async () => {
      const gc = await extras.globalConfig.load();
      // Pull a pending saved-search filter from globalState (set by
      // `vscodesync.activityApplySavedSearch`) and clear it so the next plain
      // open doesn't re-apply it.
      const PENDING_KEY = "vscodesync.activity.pendingApplyFilter";
      const pending = context.globalState.get<unknown>(PENDING_KEY);
      const applyFilter =
        pending !== null && typeof pending === "object"
          ? (pending as { kind?: string; workspaceId?: string; query?: string })
          : undefined;
      if (applyFilter) {
        await context.globalState.update(PENDING_KEY, undefined);
      }
      openActivityFeedPanel(context, extras.globalConfig.getStorageDir(), gc.machineName, {
        applyFilter,
        onFilterChanged: (filter) => {
          void setLastAppliedFilter(context, filter);
        },
      });
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
      const { WorkspaceConfigManager: WCM } = await import("../core/workspaceConfigManager.js");
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

      const { manifestCloudPath } = await import("../core/cloudLayout.js");
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
      const { WorkspaceConfigManager: WCM } = await import("../core/workspaceConfigManager.js");
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

    vscode.commands.registerCommand("vscodesync.smartPauseDropdown", async () => {
      const cfg = vscode.workspace.getConfiguration("vscodesync");
      type Mode = "off" | "metered" | "battery" | "all" | "manual";
      const meterOn = cfg.get<boolean>("pauseOnMeteredConnection", false);
      const batThr = cfg.get<number>("pauseBatteryThreshold", 0);
      const cur: Mode =
        meterOn && batThr > 0
          ? "all"
          : meterOn
            ? "metered"
            : batThr > 0
              ? "battery"
              : "off";
      const items: (vscode.QuickPickItem & { value: Mode; thr?: number })[] = [
        { label: "$(circle-slash) Off", description: "Авто-паузу выключить", value: "off", picked: cur === "off" },
        { label: "$(plug) Metered only", description: "Пауза при metered-соединении", value: "metered", picked: cur === "metered" },
        { label: "$(zap) Battery <30%", description: "Пауза при низкой батарее", value: "battery", thr: 30, picked: cur === "battery" },
        { label: "$(warning) Battery+Metered (max savings)", description: "Включить обе авто-паузы", value: "all", thr: 30, picked: cur === "all" },
        { label: "$(debug-pause) Toggle manual pause", description: "Ручная пауза текущей сессии", value: "manual" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: "VSCodeSync · авто-пауза",
        placeHolder: `Текущий режим: ${cur}`,
      });
      if (!pick) return;
      if (pick.value === "manual") {
        await vscode.commands.executeCommand("vscodesync.togglePause");
        return;
      }
      const meter = pick.value === "metered" || pick.value === "all";
      const batteryThr = pick.value === "battery" || pick.value === "all" ? (pick.thr ?? 30) : 0;
      await cfg.update("pauseOnMeteredConnection", meter, vscode.ConfigurationTarget.Global);
      await cfg.update("pauseBatteryThreshold", batteryThr, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        `VSCodeSync auto-pause: metered=${meter ? "on" : "off"}, battery<${String(batteryThr)}%${batteryThr === 0 ? " (off)" : ""}.`,
      );
    }),

    vscode.commands.registerCommand("vscodesync.configurePathMapping", async () => {
      await runConfigurePathMapping(extras.globalConfig);
    }),

    vscode.commands.registerCommand("vscodesync.editWorkspaceIgnorePatterns", async () => {
      await runEditWorkspaceIgnorePatterns({
        globalConfig: extras.globalConfig,
        tryAuthenticatedProvider: extras.tryAuthenticatedProvider,
        makeEngine: extras.makeEngine,
      });
    }),

    vscode.commands.registerCommand("vscodesync.exportEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const key = await readEncryptionKey(secrets);
      if (!key) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: ключ шифрования не найден. Включите vscodesync.encryption и перезапустите VSCode.",
        );
        return;
      }
      const password = await vscode.window.showInputBox({
        prompt: "Пароль для защиты файла ключа (не меньше 8 символов)",
        password: true,
        validateInput: (v) => (v.length >= 8 ? null : "Минимум 8 символов"),
      });
      if (!password) {
        return;
      }
      const blob = await exportKeyWithPassword(key, password);
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(".vscodesync-key.enc"),
        filters: { "VSCodeSync Key": ["enc"] },
      });
      if (!uri) {
        return;
      }
      const { writeFile, mkdir } = await import("node:fs/promises");
      const nodePath = await import("node:path");
      await mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await writeFile(uri.fsPath, blob);
      void vscode.window.showInformationMessage(
        "VSCodeSync: ключ экспортирован. Сохраните файл в безопасном месте — без него расшифровать данные невозможно.",
      );
    }),

    vscode.commands.registerCommand("vscodesync.importEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const openResult = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "VSCodeSync Key": ["enc"] },
      });
      const fileUri = openResult?.[0];
      if (!fileUri) {
        return;
      }
      const password = await vscode.window.showInputBox({
        prompt: "Пароль от файла ключа",
        password: true,
      });
      if (password === undefined) {
        return;
      }
      try {
        const { readFile } = await import("node:fs/promises");
        const blob = await readFile(fileUri.fsPath);
        const key = await importKeyWithPassword(blob, password);
        await storeEncryptionKey(secrets, key);
        void vscode.window.showInformationMessage("VSCodeSync: ключ шифрования импортирован и сохранён.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`VSCodeSync: ошибка импорта ключа — ${msg}`);
      }
    }),

    vscode.commands.registerCommand("vscodesync.rotateEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const encryptionOn = vscode.workspace.getConfiguration(CFG).get<boolean>("encryption", false);
      if (!encryptionOn) {
        await vscode.window.showWarningMessage("VSCodeSync: шифрование не включено (vscodesync.encryption: false).");
        return;
      }
      const oldKey = await readEncryptionKey(secrets);
      if (!oldKey) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: старый ключ не найден. Включите vscodesync.encryption и перезапустите VSCode.",
        );
        return;
      }
      // Exporting the current key first is not advice, it is the recovery path.
      // Rotation rewrites every cloud blob; if it stops half way the only thing
      // that can still read the untouched half is the old key.
      const exportedFirst = await vscode.window.showWarningMessage(
        "VSCodeSync: перед ротацией ключа экспортируйте текущий ключ. " +
          "Если ротация прервётся, только он откроет ещё не перешифрованные файлы.",
        { modal: true },
        "Экспортировать сейчас",
        "Ключ уже сохранён",
      );
      if (exportedFirst === undefined) {
        return;
      }
      if (exportedFirst === "Экспортировать сейчас") {
        await vscode.commands.executeCommand("vscodesync.exportEncryptionKey");
      }
      const confirm = await vscode.window.showWarningMessage(
        "VSCodeSync: Ротация ключа шифрования. Перед началом будут созданы авто-снапшоты всех workspace. Все облачные файлы будут перезашифрованы. Продолжить?",
        { modal: true },
        "Начать ротацию",
      );
      if (confirm !== "Начать ротацию") {
        return;
      }
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
        return;
      }
      const gc = await extras.globalConfig.load();

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: ротация ключа…", cancellable: false },
        async (progress) => {
          // Step 1: auto-snapshots. A failure here is fatal, not "non-fatal":
          // the snapshot is the safety net for precisely this operation, and
          // rotating without it means rewriting every blob with no way back.
          const folders = vscode.workspace.workspaceFolders ?? [];
          const snapshotDate = new Date().toISOString().replace(/[:.]/g, "-");
          let totalFiles = 0;
          const snapshotFailures: string[] = [];
          for (const folder of folders) {
            const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
            for (const ws of wc.activeWorkspaces) {
              progress.report({ message: `Снапшот workspace ${ws.workspaceNote || ws.workspaceId}…` });
              try {
                await createWorkspaceSnapshot(provider, folder.uri.fsPath, ws.workspaceId, `auto-pre-key-rotation-${snapshotDate}`, gc.machineName);
              } catch (e) {
                snapshotFailures.push(
                  `${ws.workspaceNote || ws.workspaceId}: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              totalFiles += wc.files.filter((f) => f.workspaceId === ws.workspaceId).length;
            }
          }
          if (snapshotFailures.length > 0) {
            await vscode.window.showErrorMessage(
              "VSCodeSync: ротация отменена — не удалось создать страховочные снапшоты:\n" +
                snapshotFailures.join("\n"),
            );
            return;
          }

          // Step 2: Generate new key
          const newKey = generateEncryptionKey();
          progress.report({ message: "Перешифровка файлов…" });

          // Step 3: re-encrypt every tracked blob, remembering what succeeded.
          const reEncrypted: string[] = [];
          const failures: { cloudPath: string; localPath: string; error: string }[] = [];
          let seen = 0;
          for (const folder of folders) {
            const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
            for (const file of wc.files) {
              if (!file.cloudPath) {
                continue;
              }
              seen++;
              progress.report({ message: `${String(seen)}/${String(totalFiles)}: ${file.localPath}` });
              try {
                const dl = await provider.downloadFile(file.cloudPath);
                const plaintext = decryptBuffer(oldKey, dl.body);
                const newCiphertext = encryptBuffer(newKey, plaintext);
                await provider.uploadFile(file.cloudPath, newCiphertext, { ifMatch: dl.etag });
                reEncrypted.push(file.cloudPath);
              } catch (e) {
                failures.push({
                  cloudPath: file.cloudPath,
                  localPath: file.localPath,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
          }

          // Step 4: the key is stored only when every blob was rewritten.
          //
          // It used to be stored unconditionally, right after a loop that
          // swallowed every per-file error. Any file that failed re-encryption
          // stayed under the old key, which was then overwritten — the file
          // became permanently unreadable, and the report still claimed success.
          if (failures.length === 0) {
            await storeEncryptionKey(secrets, newKey);
            await extras.refreshAfterLocalConfigChange?.();
            void vscode.window
              .showInformationMessage(
                `VSCodeSync: ротация ключа завершена. Перешифровано файлов: ${String(reEncrypted.length)}. Экспортируйте новый ключ.`,
                "Экспортировать",
              )
              .then(async (choice) => {
                if (choice === "Экспортировать") {
                  await vscode.commands.executeCommand("vscodesync.exportEncryptionKey");
                }
              });
            return;
          }

          // Rollback: both keys are still in hand, so the blobs already rewritten
          // can be put back under the old key and the old key kept in place.
          progress.report({ message: "Откат: возвращаю перешифрованные файлы под старый ключ…" });
          const rollbackFailures: string[] = [];
          for (const cloudPath of reEncrypted) {
            try {
              const dl = await provider.downloadFile(cloudPath);
              const plaintext = decryptBuffer(newKey, dl.body);
              await provider.uploadFile(cloudPath, encryptBuffer(oldKey, plaintext), {
                ifMatch: dl.etag,
              });
            } catch (e) {
              rollbackFailures.push(`${cloudPath}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          if (rollbackFailures.length === 0) {
            await vscode.window.showErrorMessage(
              `VSCodeSync: ротация отменена и полностью откачена. Ключ НЕ изменён. ` +
                `Не удалось перешифровать файлов: ${String(failures.length)} ` +
                `(${failures.slice(0, 3).map((f) => f.localPath).join(", ")}${failures.length > 3 ? ", …" : ""}). ` +
                "Устраните причину и повторите.",
            );
            return;
          }

          // Partial rollback: some blobs are under the new key and cannot be put
          // back. Keeping the old key would make exactly those unreadable, so the
          // new key wins and the user is told precisely which files need the
          // exported old key.
          await storeEncryptionKey(secrets, newKey);
          await extras.refreshAfterLocalConfigChange?.();
          await vscode.window.showErrorMessage(
            "VSCodeSync: ротация завершилась частично. Новый ключ сохранён, потому что откатить удалось не всё.\n" +
              `Под НОВЫМ ключом: ${String(reEncrypted.length - rollbackFailures.length)} файлов и ещё ${String(rollbackFailures.length)}, которые не удалось вернуть.\n` +
              `Под СТАРЫМ ключом остались: ${failures.map((f) => f.localPath).join(", ")}.\n` +
              "Восстановите их экспортированным старым ключом или из авто-снапшота " +
              `auto-pre-key-rotation-${snapshotDate}.`,
          );
        },
      );
    }),
    vscode.commands.registerCommand("vscodesync.exportWorkspaceStructure", async () => {
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      type Epick = vscode.QuickPickItem & { mode: "portable" | "full" };
      const pick = await vscode.window.showQuickPick<Epick>(
        [
          {
            label: "Портативная структура (для коллег)",
            description: "schema 2: workspace id, пути; без хэшей и токенов",
            mode: "portable",
          },
          {
            label: "Полный локальный кэш",
            description: "schema 1: activeWorkspaces + files как в vscodesync.json",
            mode: "full",
          },
        ],
        { placeHolder: "Тип экспорта структуры workspace" },
      );
      if (!pick) {
        return;
      }
      if (pick.mode === "full") {
        await exportWorkspaceStructureFullCache(root);
        return;
      }
      const gc = await extras.globalConfig.load();
      await exportWorkspaceStructure(root, gc.machineName);
    }),
    vscode.commands.registerCommand("vscodesync.restoreFromCloud", async () => {
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
        return;
      }
      const target = await runCloudExportFlow(provider, "Папка для восстановления (откроется как workspace)");
      if (!target) return;
      await vscode.window
        .showInformationMessage(
          `VSCodeSync: восстановление в ${target}. Открыть как workspace?`,
          "Открыть",
          "Не сейчас",
        )
        .then((choice) => {
          if (choice === "Открыть") {
            void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), true);
          }
        });
    }),
    vscode.commands.registerCommand("vscodesync.exportWorkspaceToFolder", async () => {
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
        return;
      }
      const target = await runCloudExportFlow(provider, "Целевая папка для экспорта");
      if (target) {
        void vscode.window.showInformationMessage(`VSCodeSync: экспортировано в ${target}.`);
      }
    }),
    vscode.commands.registerCommand("vscodesync.importWorkspaceStructure", async () => {
      const root = await resolveWorkspaceRootForPaletteCommand();
      if (!root) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      try {
        await importWorkspaceStructure(root, {
          globalConfig: extras.globalConfig,
          makeEngine: extras.makeEngine,
          tryAuthenticatedProvider: extras.tryAuthenticatedProvider ?? (() => Promise.resolve(null)),
        });
        await extras.refreshAfterLocalConfigChange?.();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`VSCodeSync Import: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("vscodesync.mergeWorkspaces", async () => {
      await runMergeWorkspaces({
        globalConfig: extras.globalConfig,
        tryAuthenticatedProvider: extras.tryAuthenticatedProvider,
        makeEngine: extras.makeEngine,
        refreshAfterLocalConfigChange: extras.refreshAfterLocalConfigChange,
      });
    }),
    vscode.commands.registerCommand("vscodesync.startSyncRecording", async () => {
      const { startRecording, isRecording } = await import("./syncReplayRecorderState.js");
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
      const { stopRecording, isRecording } = await import("./syncReplayRecorderState.js");
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
      const { loadActivityFile } = await import("../core/activityLog.js");
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
      const { rankGarbageCandidates, suggestIgnorePatterns } = await import("../core/aiGarbageTrackedDetector.js");
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
    vscode.commands.registerCommand("vscodesync.showStorageReport", async () => {
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
        return;
      }
      const { CLOUD_ROOT_DIR } = await import("../core/cloudLayout.js");
      // Walk one level (workspace dirs); for each, list manifest+meta+files
      // (depth ≤ 3 in practice; per-snapshot deep walk skipped — surfaces top-level).
      interface Entry { cloudPath: string; size?: number }
      const collect = async (dir: string, depth: number, into: Entry[]): Promise<void> => {
        if (depth > 4) return;
        let listing: Awaited<ReturnType<typeof provider.listFolder>>;
        try { listing = await provider.listFolder(dir); } catch { return; }
        for (const e of listing) {
          if (e.size === undefined) {
            await collect(e.cloudPath, depth + 1, into);
          } else {
            into.push({ cloudPath: e.cloudPath, size: e.size });
          }
        }
      };
      const all: Entry[] = [];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: подсчёт занятого места…", cancellable: false },
        async () => { await collect(CLOUD_ROOT_DIR, 0, all); },
      );
      const { buildStorageUsageReport, formatBytes } = await import("../core/storageUsageReport.js");
      const report = buildStorageUsageReport(all, 10);
      const channel = vscode.window.createOutputChannel("VSCodeSync · storage report");
      channel.clear();
      channel.appendLine(`Всего файлов: ${String(report.totalFiles)} · ${formatBytes(report.totalBytes)}`);
      channel.appendLine("");
      channel.appendLine(`По workspace (${String(report.perWorkspace.length)}):`);
      for (const w of report.perWorkspace) {
        channel.appendLine(`  ${formatBytes(w.totalBytes).padStart(10)} · ${String(w.fileCount).padStart(5)} файлов · ${w.workspaceId}`);
      }
      channel.appendLine("");
      channel.appendLine(`Топ-${String(report.topFiles.length)} крупнейших файлов:`);
      for (const f of report.topFiles) {
        channel.appendLine(`  ${formatBytes(f.size).padStart(10)} · ${f.cloudPath}`);
      }
      channel.show(true);
    }),
    vscode.commands.registerCommand("vscodesync.showConflictHeatmap", async () => {
      const { getHotZones } = await import("./conflictHeatmapStoreFs.js");
      const zones = await getHotZones(extras.globalConfig.getStorageDir(), 1);
      if (zones.length === 0) {
        void vscode.window.showInformationMessage(
          "VSCodeSync: ещё нет записанных разрешений конфликтов.",
        );
        return;
      }
      const channel = vscode.window.createOutputChannel("VSCodeSync · conflict heatmap");
      channel.clear();
      channel.appendLine(`Hot files (${String(zones.length)}):`);
      channel.appendLine("");
      for (const z of zones) {
        channel.appendLine(`  ${String(z.count).padStart(3)} × ${z.relPath} (lines ${String(z.startLine)}-${String(z.endLine)})`);
      }
      channel.show(true);
    }),
  );
}

/**
 * Shared "pick cloud workspace + pick local folder + download all files"
 * flow used by Export-to-Folder and Restore-from-Cloud. Returns the target
 * absolute path on success, undefined on cancel/error.
 */
/**
 * `_meta` rows for a cloud workspace, keyed by tracked path. Only `wireGzip`
 * matters here: it decides whether the blob lives under a `.gz` suffix.
 * Missing or unreadable `_meta` yields an empty map, which degrades to the old
 * "assume uncompressed" behaviour rather than failing the whole export.
 */
async function readCloudMetaRows(
  provider: ICloudProvider,
  workspaceId: string,
): Promise<Record<string, { wireGzip?: boolean } | undefined>> {
  const { metaCloudPath } = await import("../core/cloudLayout.js");
  const dl = await provider.downloadFile(metaCloudPath(workspaceId)).catch(() => null);
  if (!dl) return {};
  try {
    const parsed = JSON.parse(dl.body.toString("utf8")) as {
      files?: Record<string, { wireGzip?: boolean }>;
    };
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

async function runCloudExportFlow(
  provider: ICloudProvider,
  pickFolderTitle: string,
): Promise<string | undefined> {
  const { listCloudWorkspacesViaPaths } = await import("../core/cloudWorkspaceLister.js");
  const cloudWs = await listCloudWorkspacesViaPaths(provider);
  if (cloudWs.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: на облаке нет workspace'ов.");
    return undefined;
  }
  type WPick = vscode.QuickPickItem & { workspaceId: string };
  const items: WPick[] = cloudWs.map((w) => ({
    label: w.workspaceNote || w.workspaceId,
    description: `${w.workspaceId} · ${String(w.fileCount)} файлов`,
    workspaceId: w.workspaceId,
  }));
  const picked = await vscode.window.showQuickPick<WPick>(items, { placeHolder: "Workspace" });
  if (!picked) return undefined;

  const folderUris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: pickFolderTitle,
  });
  const target = folderUris?.[0]?.fsPath;
  if (!target) return undefined;

  const { manifestCloudPath } = await import("../core/cloudLayout.js");
  const { blobCloudPath } = await import("../core/wireCompression.js");
  const { decodeCloudBlob } = await import("../core/cloudBlobCodec.js");
  const dl = await provider.downloadFile(manifestCloudPath(picked.workspaceId)).catch(() => null);
  if (!dl) {
    await vscode.window.showWarningMessage("VSCodeSync: облачный манифест недоступен.");
    return undefined;
  }
  const { parseManifestSafe } = await import("../core/manifestValidate.js");
  const parsed = parseManifestSafe(dl.body);
  if (!parsed.ok) {
    await vscode.window.showErrorMessage(`VSCodeSync: облачный манифест невалидный: ${parsed.reason}`);
    return undefined;
  }
  const { planWorkspaceExport, escapingPaths } = await import("../core/workspaceExportPlan.js");
  const plan = planWorkspaceExport(parsed.value, target);
  if (plan.empty) {
    void vscode.window.showInformationMessage("VSCodeSync: workspace не содержит файлов.");
    return undefined;
  }
  const escapes = escapingPaths(plan);
  if (escapes.length > 0) {
    await vscode.window.showErrorMessage(
      `VSCodeSync: ${String(escapes.length)} путей вне выбранной папки — отказ.`,
    );
    return undefined;
  }
  // Export writes cloud blobs straight to disk without going through the
  // engine, so it has no decryption key. Writing ciphertext into the user's
  // folder while reporting success is worse than refusing.
  if (vscode.workspace.getConfiguration(CFG).get<boolean>("encryption", false)) {
    await vscode.window.showErrorMessage(
      "VSCodeSync: экспорт зашифрованного workspace пока не поддерживается — " +
        "на диск попал бы шифротекст. Используйте Pull в подключённую папку.",
    );
    return undefined;
  }

  // `_meta` tells which blobs are stored gzipped. The path used to be built
  // with `trackedFileCloudPath`, i.e. always without the `.gz` suffix, so every
  // compressed file simply failed to download — silently, see below.
  const metaRows = await readCloudMetaRows(provider, picked.workspaceId);

  let failed = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: загрузка файлов…", cancellable: false },
    async (progress) => {
      let done = 0;
      for (const entry of plan.entries) {
        const wireGzip = metaRows[entry.posixRel]?.wireGzip === true;
        try {
          const dlFile = await provider.downloadFile(
            blobCloudPath(picked.workspaceId, entry.posixRel, wireGzip),
          );
          const body = decodeCloudBlob(dlFile.body, wireGzip, {});
          await fs.mkdir(path.dirname(entry.targetAbs), { recursive: true });
          await fs.writeFile(entry.targetAbs, body);
          // `done` used to be incremented outside the `try`, so the progress
          // counter reached 100 % even when nothing had been written.
          done++;
        } catch {
          failed++;
        }
        progress.report({
          message: `${String(done)}/${String(plan.entries.length)}`,
        });
      }
    },
  );
  if (failed > 0) {
    await vscode.window.showWarningMessage(
      `VSCodeSync: экспорт завершён с ошибками — не скачано файлов: ${String(failed)} из ${String(plan.entries.length)}.`,
    );
  }
  return target;
}
