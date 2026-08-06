import * as vscode from "vscode";
import * as path from "node:path";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import {
  applyQuickTransferReceive,
  listIncomingQuickTransfers,
  prepareQuickTransferReceive,
  sendQuickTransferFile,
  type QuickTransferApplyMode,
} from "../core/quickTransfer.js";
import { readLocalBackupSettings } from "./localBackupSettings.js";
import { allowImmediateOfflineFlushRetry, bumpOfflineFlushBackoff } from "../core/syncOfflineFlushBackoff.js";
import { noteCloudTransportFailure } from "../core/syncOfflineHints.js";
import { isLikelyUnreachableError } from "../utils/networkErrors.js";
import { guardPathsBeforePush } from "./syncGuards.js";
import { showSyncInfo, showSyncError, showSyncWarning } from "./notificationService.js";
import { readMachinesRegistrySafe } from "../core/machineRegistry.js";
import { classifyPresence, describePresence } from "./machinePresenceStatus.js";

const CFG_SECTION = "vscodesync";
const DISMISSED_KEY = "vscodesync.quickTransfer.dismissedIds";

import { resolveDefaultWorkspaceRootFsPath } from "../utils/workspaceRootResolver.js";

function pickRoot(): string | undefined {
  return resolveDefaultWorkspaceRootFsPath();
}

export function registerQuickTransferFeatures(
  context: vscode.ExtensionContext,
  deps: {
    globalConfig: GlobalConfigManager;
    ensureProvider: () => Promise<ICloudProvider | null>;
    offlineQueue?: SyncOfflineQueueStore;
    resolveFileTargetLoose: (
      arg?: unknown,
    ) => Promise<{ root: string; fsPath: string } | undefined>;
    refreshUi: () => Promise<void>;
  },
): void {
  let pollSeq = 0;
  let lastPollMs = 0;

  const pollIncoming = async (): Promise<void> => {
    const root = pickRoot();
    if (!root) {
      return;
    }
    const now = Date.now();
    if (now - lastPollMs < 45_000) {
      return;
    }
    lastPollMs = now;
    const seq = ++pollSeq;
    let provider: ICloudProvider | null;
    try {
      provider = await deps.ensureProvider();
    } catch {
      return;
    }
    if (!provider) {
      return;
    }
    const gc = await deps.globalConfig.load();
    let incoming: Awaited<ReturnType<typeof listIncomingQuickTransfers>>;
    try {
      incoming = await listIncomingQuickTransfers(provider, gc.machineId);
    } catch {
      return;
    }
    if (seq !== pollSeq) {
      return;
    }
    const dismissedRaw = context.globalState.get<string[]>(DISMISSED_KEY);
    const dismissed = new Set(Array.isArray(dismissedRaw) ? dismissedRaw : []);
    for (const q of incoming) {
      if (dismissed.has(q.transferId)) {
        continue;
      }
      const sentLabel = new Date(q.meta.sentAt).toLocaleString(vscode.env.language);
      // Incoming Quick Transfer notifications respect "normal" level (skipped when "minimal")
      const choice = await showSyncInfo(
        `Quick Transfer от «${q.meta.fromMachineName}»: ${q.meta.relativePath} • ${sentLabel}`,
        "normal",
        "Получить",
        "Ответить",
        "Игнорировать",
      );
      if (seq !== pollSeq) {
        return;
      }
      if (choice === "Получить") {
        try {
          const prepared = await prepareQuickTransferReceive(provider, q.transferId, root, gc.machineName);
          // An existing local file is never overwritten without a word (D7):
          // the package is already downloaded, so the choice costs nothing and
          // the cloud copy stays put until something lands on disk.
          let mode: QuickTransferApplyMode | null = "overwrite";
          if (prepared.destExists) {
            const what = await vscode.window.showWarningMessage(
              `VSCodeSync: «${prepared.relSafe}» уже существует локально.`,
              { modal: true },
              "Перезаписать (с бэкапом)",
              "Сохранить рядом",
            );
            mode =
              what === "Перезаписать (с бэкапом)"
                ? "overwrite"
                : what === "Сохранить рядом"
                  ? "side-by-side"
                  : null;
          }
          if (mode === null) {
            continue;
          }
          const backupCfg = readLocalBackupSettings(root);
          const r = await applyQuickTransferReceive(provider, prepared, mode, {
            workspaceRoot: root,
            backup: backupCfg.enabled
              ? { retentionDays: backupCfg.retentionDays, backupDir: backupCfg.backupDir }
              : undefined,
          });
          await showSyncInfo(`VSCodeSync: файл сохранён — ${r.savedTo}`, "normal");
          await deps.refreshUi();
        } catch (e) {
          // Handle 404 gracefully (race condition: another machine already received it)
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.toLowerCase().includes("not_found") || msg.toLowerCase().includes("not found")) {
            await showSyncInfo(`VSCodeSync: Quick Transfer недоступен — уже получен другой машиной или истёк.`, "normal");
          } else {
            await showSyncError(`VSCodeSync Quick Transfer: ${msg}`);
          }
        }
      } else if (choice === "Ответить") {
        // Reply to sender — open Send dialog pre-filled with sender's machineId
        await vscode.commands.executeCommand(
          "vscodesync.sendQuickTransfer",
          { _replyToMachineId: q.meta.fromMachineId },
        );
      } else if (choice === "Игнорировать") {
        dismissed.add(q.transferId);
        await context.globalState.update(DISMISSED_KEY, [...dismissed]);
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.sendQuickTransfer", async (arg?: unknown) => {
      const target = await deps.resolveFileTargetLoose(arg);
      if (!target) {
        return;
      }
      if (!(await guardPathsBeforePush([target.fsPath]))) {
        return;
      }
      const provider = await deps.ensureProvider();
      if (!provider) {
        return;
      }
      const gc = await deps.globalConfig.load();
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const ttl = cfg.get<number>("quickTransferTtlDays", 7);
      const mb = cfg.get<number>("maxFileSizeMB", 5);
      const maxB = Math.max(0, mb) * 1024 * 1024;
      const rel = path.relative(target.root, target.fsPath).split(path.sep).join("/");

      // Machine picker: fetch _machines.json and let the user pick a target
      let targetMachineId: string | undefined;
      // If called from "Reply" in an incoming notification, pre-select the sender
      const replyToMachineId =
        arg && typeof arg === "object" && "_replyToMachineId" in arg
          ? String((arg as Record<string, unknown>)._replyToMachineId)
          : undefined;

      try {
        const machines = await readMachinesRegistrySafe(provider);
        if (machines && machines.length > 0) {
          const otherMachines = machines.filter((m) => m.machineId !== gc.machineId);
          if (otherMachines.length > 0) {
            if (replyToMachineId) {
              // Pre-select the sender in reply mode
              targetMachineId = replyToMachineId;
            } else {
              type MachinePick = vscode.QuickPickItem & { machineId?: string };
              const now = Date.now();
              const items: MachinePick[] = [
                { label: "$(broadcast) Все машины", description: "доступно любой машине", machineId: undefined },
                ...otherMachines.map((m) => {
                  const status = classifyPresence(m.lastSeen, now);
                  const dot =
                    status === "online" ? "$(circle-filled)" :
                    status === "recent" ? "$(circle-outline)" :
                    "$(circle-slash)";
                  return {
                    label: `${dot} ${m.machineName}`,
                    description: describePresence(m.lastSeen, now),
                    machineId: m.machineId,
                  };
                }),
              ];
              const picked = await vscode.window.showQuickPick<MachinePick>(items, {
                placeHolder: "Кому отправить?",
              });
              if (!picked) {
                return;
              }
              targetMachineId = picked.machineId;
            }
          }
        }
      } catch {
        // Non-fatal: if machines list fails, send to all
      }

      try {
        const { expiresAtIso } = await sendQuickTransferFile(provider, {
          machineId: gc.machineId,
          machineName: gc.machineName,
          ttlDays: ttl,
          absolutePath: target.fsPath,
          projectRelativePosix: rel,
          targetMachineId,
          maxFileSizeBytes: maxB > 0 ? maxB : undefined,
        });
        const until = new Date(expiresAtIso).toLocaleString(vscode.env.language);
        const toLabel = targetMachineId
          ? `машине ${targetMachineId}`
          : "всем машинам";
        await showSyncInfo(
          `VSCodeSync: файл отправлен разово ${toLabel} (без трекинга). Доступен до ${until}.`,
          "normal",
        );
      } catch (e) {
        if (deps.offlineQueue && isLikelyUnreachableError(e)) {
          const queuedAtIso = new Date().toISOString();
          await deps.offlineQueue.enqueueQuickTransferSend({
            queuedAtIso,
            ttlDays: ttl,
            absolutePath: target.fsPath,
            projectRelativePosix: rel,
            maxFileSizeBytes: maxB > 0 ? maxB : undefined,
          });
          bumpOfflineFlushBackoff();
          allowImmediateOfflineFlushRetry();
          noteCloudTransportFailure();
          await showSyncWarning(
            `VSCodeSync: нет связи с облаком — Quick Transfer поставлен в оффлайн-очередь (${rel}).`,
            "normal",
          );
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        await showSyncError(`VSCodeSync Quick Transfer: ${msg}`);
      }
    }),

    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        void pollIncoming();
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void pollIncoming();
    }),
  );

  const timer = setInterval(() => {
    void pollIncoming();
  }, 120_000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
    },
  });

  void pollIncoming();
}
