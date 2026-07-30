/**
 * v0.15 Phase 21 — wiring bundle for the pure helpers added in v0.8–v0.14.
 *
 * Each command here calls into one helper to keep wiring colocated; the
 * helpers themselves stay `vscode`-free and unit-testable.
 *
 * Bundled here (vs scattered across registerSettings / registerDiagnostics
 * / registerHeavyMisc) because the surface is uniform: each command just
 * gathers state, calls a pure planner / parser, and surfaces the result
 * through a webview / QuickPick / OutputChannel.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXTENSION_ID } from "../core/extensionIdentity.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import {
  explainFileSyncState,
  formatExplainReportMarkdown,
  type ExplainFileSyncStateInput,
} from "../core/explainFileSyncState.js";
import { parseAutoSyncMode } from "../core/autoSyncMode.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "../core/syncWorkspaceInstanceReadOnly.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { isAutoSyncBlockedBySchedule } from "../ui/syncScheduleGate.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { planRepairManifest, describeRepairPlan } from "../core/repairManifestPlanner.js";
import {
  describeAutoSyncMode,
} from "../core/autoSyncMode.js";
import {
  manifestCloudPath,
  machinesRegistryCloudPath,
} from "../core/cloudLayout.js";
import { parseMachinesRegistry } from "../core/machineRegistry.js";
import type { SupportBundleFileName } from "../core/supportBundleContents.js";
import { loadActivityFile } from "../core/activityLog.js";
import { getLastHealthReport } from "../core/lastHealthReportStore.js";
import { readRecentLogLines } from "../utils/logVscode.js";
import { snapshotGlobalQueues } from "../core/requestQueue.js";
import { snapshotSyncFileLocks, syncFileLockTailCount } from "../core/syncFileLock.js";
import { describeWorkspaceInstanceLockForHealth } from "../core/workspaceInstanceLock.js";
import { buildSyncProfileReport, type SyncProfileBuffer } from "../core/syncProfileBuffer.js";
import {
  buildExplainConflictPrompt,
  normaliseConflictExplanation,
} from "../core/aiExplainConflictPrompt.js";
import {
  buildSupportBundleManifest,
  redactSettings,
  redactString,
} from "../core/supportBundleSanitizer.js";
import { buildVscodeSyncUri } from "../core/vscodesyncUriParser.js";
import { buildSbomReport, formatSbomMarkdown } from "../core/sbomReport.js";
import { encodeInviteLink, decodeInviteLink } from "../core/workspaceInviteLink.js";

const CFG = "vscodesync";

export interface Phase21CommandsDeps {
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
  /** Auth-aware lookup of the active provider. */
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  /** Run an op with an authenticated engine + provider. */
  runWithEngine: RunWithEngineFn;
  /** Engine factory used by Health-Check-like ops. */
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
  /** Sync profiler samples — written into the support bundle. */
  profileBuffer: SyncProfileBuffer;
}

export function registerPhase21Commands(deps: Phase21CommandsDeps): vscode.Disposable[] {
  const out: vscode.Disposable[] = [];

  // v0.17 A3 — gate destructive commands behind workspace trust. Read-only
  // commands (explain state) are fine in untrusted; mutating ones (repair
  // manifest, keep-both, ai-explain via clipboard) need trust.
  const ensureTrusted = async (): Promise<boolean> => {
    if (vscode.workspace.isTrusted) return true;
    await vscode.window.showWarningMessage(
      "VSCodeSync: команда требует Workspace Trust. Откройте Manage Workspace Trust и перезапустите.",
    );
    return false;
  };

  // W01 — Repair cloud manifest.
  out.push(
    vscode.commands.registerCommand("vscodesync.repairCloudManifest", async () => {
      if (!(await ensureTrusted())) return;
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку workspace.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет подключённых workspace'ов.");
        return;
      }
      const provider = await deps.tryAuthenticatedProvider();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: войдите в облачный провайдер.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        wc.activeWorkspaces.map((aw) => ({
          label: aw.workspaceNote || aw.workspaceId,
          description: aw.workspaceId,
          ws: aw,
        })),
        { placeHolder: "Какой workspace восстановить?" },
      );
      if (!picked) return;
      const gc = await deps.globalConfig.load();
      const engine = deps.makeEngine(folder.uri.fsPath, provider, gc.machineId, gc.machineName, "user");
      // Scan cloud, gather files + machines.
      const cloudFilePaths = await engine.listCloudWorkspaceFiles(picked.ws.workspaceId).catch(() => [] as string[]);
      let machines: Awaited<ReturnType<typeof parseMachinesRegistry>> = [];
      try {
        const reg = await provider.downloadFile(machinesRegistryCloudPath());
        machines = parseMachinesRegistry(reg.body);
      } catch { /* missing registry — start with empty list */ }
      const plan = planRepairManifest({
        workspaceId: picked.ws.workspaceId,
        workspaceNoteHint: picked.ws.workspaceNote,
        providerType: provider.type,
        cloudFilePaths,
        machines,
      });
      const confirm = await vscode.window.showWarningMessage(
        `VSCodeSync: ${describeRepairPlan(plan, picked.ws.workspaceId)} Продолжить?`,
        { modal: true },
        "Восстановить",
      );
      if (confirm !== "Восстановить") return;
      try {
        const body = Buffer.from(`${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8");
        await provider.uploadFile(manifestCloudPath(picked.ws.workspaceId), body);
        void vscode.window.showInformationMessage(
          `VSCodeSync: облачный манифест восстановлен (${String(plan.rebuiltFileCount)} файлов).`,
        );
      } catch (e) {
        await vscode.window.showErrorMessage(
          `VSCodeSync: не удалось загрузить манифест — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }),
  );

  // W02 — Explain file sync state.
  const explainChannel = vscode.window.createOutputChannel("VSCodeSync · Explain");
  out.push(new vscode.Disposable(() => { explainChannel.dispose(); }));
  out.push(
    vscode.commands.registerCommand("vscodesync.explainFileSyncState", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme !== "file") {
        await vscode.window.showWarningMessage("VSCodeSync: выберите файл в Explorer или активном редакторе.");
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (!folder) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в workspace folder.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      const posixRel = path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join("/");
      const fileEntry = wc.files.find((f) => f.localPath === posixRel);
      const wsEntry = fileEntry
        ? wc.activeWorkspaces.find((w) => w.workspaceId === fileEntry.workspaceId)
        : undefined;
      const autoMode = parseAutoSyncMode(vscode.workspace.getConfiguration(CFG).get<string>("autoSyncMode", "check-only"));
      const input: ExplainFileSyncStateInput = {
        workspaceRoot: folder.uri.fsPath,
        posixRel,
        trusted: vscode.workspace.isTrusted,
        autoSyncMode: autoMode,
        sessionPaused: syncSessionPause.isPaused(),
        autoPauseActive: syncAutoPause.isActive(),
        scheduleBlocked: isAutoSyncBlockedBySchedule(),
        rateLimited: isAutoSyncBlockedByRateLimit(),
        workspaceState: wsEntry
          ? (normalizeWorkspaceSyncState(wsEntry) === "active"
            ? "active"
            : normalizeWorkspaceSyncState(wsEntry) === "suspended"
              ? "suspended"
              : "frozen")
          : "missing",
        tracked: fileEntry !== undefined,
        syncStatus: fileEntry?.syncStatus,
        editingByOther: fileEntry?.editingBy && fileEntry.editingByName
          ? { machineName: fileEntry.editingByName }
          : undefined,
        lastSyncIso: fileEntry?.lastSync,
        secondaryReadOnly: isSecondaryWorkspaceInstanceReadOnly(),
      };
      const report = explainFileSyncState(input);
      const md = formatExplainReportMarkdown(report);
      explainChannel.clear();
      for (const line of md.split("\n")) explainChannel.appendLine(line);
      explainChannel.appendLine("");
      explainChannel.appendLine(`Авто-режим: ${describeAutoSyncMode(autoMode)}`);
      explainChannel.show(true);
    }),
  );

  // W03 — Keep Both conflict.
  out.push(
    vscode.commands.registerCommand("vscodesync.resolveConflictKeepBoth", async (uri?: vscode.Uri) => {
      if (!(await ensureTrusted())) return;
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        await vscode.window.showWarningMessage("VSCodeSync: выберите файл с конфликтом.");
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (!folder) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в workspace folder.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      const posixRel = path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join("/");
      const fileEntry = wc.files.find((f) => f.localPath === posixRel);
      if (fileEntry?.syncStatus !== "conflict") {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в состоянии conflict.");
        return;
      }
      await deps.runWithEngine(async (engine: SyncEngine) => {
        await engine.resolveConflictKeepBoth(fileEntry.workspaceId, posixRel);
      }, folder.uri.fsPath);
      void vscode.window.showInformationMessage(
        "VSCodeSync: keep-both — облачная версия сохранена как `.conflict-<machine>-<ts>` рядом. Локальная — pending push.",
      );
    }),
  );

  // W10 — AI Explain Conflict.
  out.push(
    vscode.commands.registerCommand("vscodesync.aiExplainConflict", async (uri?: vscode.Uri) => {
      if (!(await ensureTrusted())) return;
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        await vscode.window.showWarningMessage("VSCodeSync: выберите файл с конфликтом.");
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (!folder) return;
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      const posixRel = path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join("/");
      const fileEntry = wc.files.find((f) => f.localPath === posixRel);
      if (fileEntry?.syncStatus !== "conflict") {
        await vscode.window.showWarningMessage("VSCodeSync: файл не в состоянии conflict.");
        return;
      }
      // Pull LOCAL content from disk; REMOTE via engine.downloadTrackedBlob.
      const localContent = await fs.readFile(target.fsPath, "utf8").catch(() => "");
      let remoteContent = "";
      await deps.runWithEngine(async (engine: SyncEngine) => {
        const dl = await engine.downloadTrackedBlob(posixRel);
        remoteContent = dl.body.toString("utf8");
      }, folder.uri.fsPath);
      const prompt = buildExplainConflictPrompt({
        posixRel,
        localContent,
        remoteContent,
        lastSyncIso: fileEntry.lastSync,
      });
      // LM integration deferred: VS Code's `vscode.lm` proposed API requires
      // package.json `enabledApiProposals` and a CI smoke test. For now,
      // copy the prompt to clipboard so the user can paste into Copilot
      // Chat / ChatGPT manually — same UX, no LM dependency.
      void normaliseConflictExplanation;
      // Fallback: copy prompt to clipboard for the user to paste elsewhere.
      await vscode.env.clipboard.writeText(`${prompt.system}\n\n${prompt.user}`);
      void vscode.window.showInformationMessage(
        "VSCodeSync: LM недоступна. Промпт скопирован в clipboard — вставьте в Copilot Chat / ChatGPT.",
      );
    }),
  );

  // W11 — Support bundle export.
  out.push(
    vscode.commands.registerCommand("vscodesync.exportSupportBundle", async () => {
      const dir = deps.globalConfig.getStorageDir();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const bundleDir = path.join(dir, `support-${ts}`);
      await fs.mkdir(bundleDir, { recursive: true });

      const writeBundleFile = async (
        name: SupportBundleFileName,
        body: string,
      ): Promise<void> => {
        await fs.writeFile(path.join(bundleDir, name), body, "utf8");
      };
      const writeBundleJson = async (
        name: SupportBundleFileName,
        value: unknown,
      ): Promise<void> => {
        await writeBundleFile(name, `${JSON.stringify(value, null, 2)}\n`);
      };

      const extPkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as
        | {
            version?: string;
            contributes?: { configuration?: { properties?: Record<string, unknown> } };
          }
        | undefined;

      // ── settings.redacted.json ────────────────────────────────────────────
      // Every declared key, read from the extension manifest at runtime. The
      // previous version sampled nine hardcoded names with the note "we don't
      // have a clean way to enumerate all keys" — this is that clean way, and
      // it means a bundle no longer hides the 89 settings nobody listed.
      const cfg = vscode.workspace.getConfiguration(CFG);
      const declaredKeys = Object.keys(extPkg?.contributes?.configuration?.properties ?? {});
      const raw: Record<string, unknown> = {};
      for (const fullKey of declaredKeys) {
        const short = fullKey.startsWith(`${CFG}.`) ? fullKey.slice(CFG.length + 1) : fullKey;
        raw[short] = cfg.get(short);
      }
      await writeBundleJson("settings.redacted.json", redactSettings(raw));

      // ── runtime-state.json ────────────────────────────────────────────────
      // The state that explains a hang. Deliberately free of network calls:
      // a support bundle must be collectable while the extension is wedged.
      const folders = vscode.workspace.workspaceFolders ?? [];
      const gcData = await deps.globalConfig.load();
      const heldLocks = snapshotSyncFileLocks();
      await writeBundleJson("runtime-state.json", {
        capturedAtIso: new Date().toISOString(),
        requestQueues: snapshotGlobalQueues(),
        heldFileLocks: heldLocks.map((l) => ({
          op: l.op,
          heldForMs: l.heldForMs,
          // Key holds an absolute path; redact it like any other value.
          key: redactString(l.key),
        })),
        fileLockTailsRetained: syncFileLockTailCount(),
        workspaceInstanceLock: await describeWorkspaceInstanceLockForHealth(
          deps.globalConfig.getStorageDir(),
          folders.map((f) => f.uri.fsPath),
        ),
        openFolderCount: folders.length,
        activeProvider: gcData.activeProvider ?? null,
      });

      // ── activity.last7d.json ──────────────────────────────────────────────
      const activityFile = await loadActivityFile(deps.globalConfig.getStorageDir());
      const cutoffMs = Date.now() - 7 * 24 * 3600_000;
      const recentEvents = activityFile.events.filter((e) => {
        const t = Date.parse(e.at);
        return Number.isFinite(t) && t >= cutoffMs;
      });
      await writeBundleJson(
        "activity.last7d.json",
        redactSettings({ schema: 1, events: recentEvents }),
      );

      // ── health-check.txt ──────────────────────────────────────────────────
      const lastHealth = getLastHealthReport();
      await writeBundleFile(
        "health-check.txt",
        lastHealth
          ? `# снято ${lastHealth.capturedAtIso}\n${lastHealth.lines.join("\n")}\n`
          : "Health Check в этой сессии не запускался — выполните команду «VSCodeSync: Health Check» и соберите bundle заново.\n",
      );

      // ── profile-sync.txt ──────────────────────────────────────────────────
      const profileSamples = deps.profileBuffer.snapshot();
      await writeBundleFile(
        "profile-sync.txt",
        `${buildSyncProfileReport(profileSamples).join("\n")}\n`,
      );

      // ── manifest-digest.json ──────────────────────────────────────────────
      // Counts and statuses only: no file paths, no hashes.
      const digests: unknown[] = [];
      for (const folder of folders) {
        const wc = await WorkspaceConfigManager.load(folder.uri.fsPath).catch(() => null);
        if (!wc) {
          digests.push({ folder: redactString(folder.uri.fsPath), error: "config unreadable" });
          continue;
        }
        const byStatus: Record<string, number> = {};
        for (const f of wc.files) {
          const key = f.syncStatus ?? "unset";
          byStatus[key] = (byStatus[key] ?? 0) + 1;
        }
        digests.push({
          workspaces: wc.activeWorkspaces.map((w) => ({
            workspaceId: w.workspaceId,
            syncState: w.syncState ?? "active",
            providerType: w.providerType ?? null,
            gitBranch: w.gitBranch ?? null,
            machineCount: w.manifestMachines?.length ?? 0,
          })),
          trackedFileCount: wc.files.length,
          filesByStatus: byStatus,
          hasPathMapping: Boolean(wc.pathMapping && Object.keys(wc.pathMapping).length > 0),
        });
      }
      await writeBundleJson("manifest-digest.json", digests);

      // ── log.txt ───────────────────────────────────────────────────────────
      const logLines = readRecentLogLines();
      await writeBundleFile(
        "log.txt",
        logLines.length > 0
          ? `${logLines.map((l) => redactString(l)).join("\n")}\n`
          : "Журнал пуст — расширение ничего не писало в канал Diagnostics с момента запуска.\n",
      );

      // ── metadata.json ─────────────────────────────────────────────────────
      // Written last so its counts describe files that already exist.
      await writeBundleJson(
        "metadata.json",
        buildSupportBundleManifest({
          vscodeVersion: vscode.version,
          extensionVersion: extPkg?.version ?? "unknown",
          platform: process.platform,
          activeProvider: gcData.activeProvider ?? undefined,
          activityEntriesCount: recentEvents.length,
          healthReportLineCount: lastHealth?.lines.length ?? 0,
          profileSampleCount: profileSamples.length,
        }),
      );

      const uri = vscode.Uri.file(bundleDir);
      await vscode.window.showInformationMessage(
        `VSCodeSync: support bundle сохранён в ${bundleDir}`,
        "Открыть папку",
      ).then((choice) => {
        if (choice === "Открыть папку") {
          void vscode.commands.executeCommand("revealFileInOS", uri);
        }
      });
    }),
  );

  // W05 part — `vscodesync.copyShareUri` companion to the URI handler.
  out.push(
    vscode.commands.registerCommand("vscodesync.copyShareUri", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (!folder) return;
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      const posixRel = path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join("/");
      const fileEntry = wc.files.find((f) => f.localPath === posixRel);
      if (!fileEntry) {
        await vscode.window.showWarningMessage("VSCodeSync: файл не отслеживается.");
        return;
      }
      const link = buildVscodeSyncUri({
        kind: "openFile",
        workspaceId: fileEntry.workspaceId,
        posixRel,
      });
      await vscode.env.clipboard.writeText(link);
      void vscode.window.showInformationMessage(`VSCodeSync: ссылка скопирована.\n${link}`);
    }),
  );

  // D04 — `vscodesync.exportSbom` — list of all synced files (Markdown).
  const sbomChannel = vscode.window.createOutputChannel("VSCodeSync · SBOM");
  out.push(new vscode.Disposable(() => { sbomChannel.dispose(); }));
  out.push(
    vscode.commands.registerCommand("vscodesync.exportSbom", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку workspace.");
        return;
      }
      const wsList: Parameters<typeof buildSbomReport>[0]["workspaces"] = [];
      for (const folder of folders) {
        try {
          const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
          for (const aw of wc.activeWorkspaces) {
            const files = wc.files
              .filter((f) => f.workspaceId === aw.workspaceId)
              .map((f) => ({
                posixRel: f.localPath,
                lastUpdatedIso: f.lastSync,
                // We don't have per-file bytes locally; use 0 placeholder.
                bytes: undefined,
                machineIds: aw.manifestMachines?.map((m) => m.machineId) ?? [],
              }));
            wsList.push({
              workspaceId: aw.workspaceId,
              workspaceNote: aw.workspaceNote || aw.workspaceId,
              files,
            });
          }
        } catch { /* skip folder on read error */ }
      }
      const report = buildSbomReport({ workspaces: wsList });
      const md = formatSbomMarkdown(report);
      sbomChannel.clear();
      for (const line of md.split("\n")) sbomChannel.appendLine(line);
      sbomChannel.show(true);
    }),
  );

  // W1 — `vscodesync.generateInviteLink`: pick a workspace, build link, copy.
  out.push(
    vscode.commands.registerCommand("vscodesync.generateInviteLink", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку workspace.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showWarningMessage("VSCodeSync: нет подключённых workspace'ов.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        wc.activeWorkspaces.map((aw) => ({
          label: aw.workspaceNote || aw.workspaceId,
          description: aw.workspaceId,
          ws: aw,
        })),
        { placeHolder: "Workspace для invite link" },
      );
      if (!picked) return;
      const ttlChoice = await vscode.window.showQuickPick(
        [
          { label: "7 дней (по умолчанию)", ttl: 168 },
          { label: "24 часа", ttl: 24 },
          { label: "30 дней", ttl: 720 },
          { label: "Без срока", ttl: 0 },
        ],
        { placeHolder: "Срок жизни invite link'а" },
      );
      if (!ttlChoice) return;
      // providerType is optional on ActiveWorkspaceEntry; fall back to
      // the global active provider before encoding.
      const providerType = picked.ws.providerType ?? (await deps.globalConfig.load()).activeProvider;
      if (!providerType) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: не определён провайдер для invite link — выберите активный провайдер.",
        );
        return;
      }
      const link = encodeInviteLink({
        workspaceId: picked.ws.workspaceId,
        workspaceNote: picked.ws.workspaceNote || picked.ws.workspaceId,
        providerType,
        ttlHours: ttlChoice.ttl,
      });
      await vscode.env.clipboard.writeText(link);
      void vscode.window.showInformationMessage(
        `VSCodeSync: invite link скопирован.\n${link}`,
      );
    }),
  );

  // W1 — `vscodesync.acceptInviteLink`: paste link, decode, route to attach.
  out.push(
    vscode.commands.registerCommand("vscodesync.acceptInviteLink", async (rawLink?: string) => {
      let link = rawLink;
      if (typeof link !== "string" || link.length === 0) {
        const input = await vscode.window.showInputBox({
          prompt: "Вставьте vscodesync://invite/... ссылку",
          ignoreFocusOut: true,
        });
        if (!input) return;
        link = input.trim();
      }
      const decoded = decodeInviteLink(link);
      if (!decoded.ok) {
        await vscode.window.showErrorMessage(
          `VSCodeSync: ссылка не принята (${decoded.error}).`,
        );
        return;
      }
      const { workspaceId, workspaceNote, providerType } = decoded.invite;
      const proceed = await vscode.window.showInformationMessage(
        `VSCodeSync: подключить workspace «${workspaceNote}» (provider: ${providerType})?`,
        { modal: true },
        "Подключить",
      );
      if (proceed !== "Подключить") return;
      // Hand off to the existing connectCloudWorkspace command which knows
      // how to negotiate provider auth + manifest download. We pre-pick
      // the workspaceId so the user doesn't go through QuickPick again.
      try {
        await vscode.commands.executeCommand("vscodesync.connectCloudWorkspace", workspaceId);
      } catch (e) {
        await vscode.window.showErrorMessage(
          `VSCodeSync: подключение не удалось — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }),
  );

  return out;
}
