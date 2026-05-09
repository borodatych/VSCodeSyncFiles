/**
 * Live presence heartbeat — periodically refreshes this machine's `lastSeen`
 * in cloud `_machines.json`. Lets other machines see who's online without
 * waiting for the next sync cycle.
 *
 * Off by default: `vscodesync.presenceHeartbeatMinutes` = 0. Recommended values:
 * 5 (responsive, ~12 req/h), 15 (lightweight). Below 1 minute is rejected.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { syncMachinesRegistrySelf } from "../core/machineRegistry.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "../core/syncWorkspaceInstanceReadOnly.js";
import { warnLog, verboseLog } from "../utils/log.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import {
  buildCurrentEditingFrame,
  shouldBroadcastCurrentEditing,
  type CurrentEditingFrame,
  type CurrentEditingMode,
} from "../core/presenceCurrentEditing.js";

export interface PresenceHeartbeatDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
}

/**
 * v2.9.2 — resolve the active editor's `(workspaceId, relPath)` against the
 * loaded `WorkspaceConfigManager`. Returns `null` when no editor is focused,
 * the editor is not file-scheme, the file is not within a workspace folder,
 * or the file is not tracked by VSCodeSync.
 */
async function resolveActiveTrackedFile(): Promise<{ workspaceId: string; relPath: string } | null> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme !== "file") return null;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) return null;
  const rel = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return null;
  const wc = await WorkspaceConfigManager.load(folder.uri.fsPath).catch(() => null);
  if (!wc) return null;
  const tracked = wc.files.find((f) => f.localPath === rel);
  if (!tracked) return null;
  return { workspaceId: tracked.workspaceId, relPath: rel };
}

export function registerPresenceHeartbeat(
  context: vscode.ExtensionContext,
  deps: PresenceHeartbeatDeps,
): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  // Guards against overlapped invocations when the cloud call takes longer
  // than the configured interval. Without it, two parallel ticks can both
  // bump `_machines.json` and create a duplicate registry entry.
  let running = false;
  // v2.9.2 — last frame we broadcast, used by `shouldBroadcastCurrentEditing`
  // to throttle re-writes when the user keeps the same file focused.
  let lastBroadcastFrame: CurrentEditingFrame | null = null;

  const reschedule = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    const minutes = vscode.workspace
      .getConfiguration("vscodesync")
      .get<number>("presenceHeartbeatMinutes", 0);
    if (minutes < 1) return;
    const intervalMs = Math.max(60_000, minutes * 60_000);
    verboseLog("presence", `heartbeat enabled, every ${String(minutes)} min`);
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runTick();
    } finally {
      running = false;
    }
  };

  const runTick = async (): Promise<void> => {
    if (syncSessionPause.isPaused()) return;
    if (isSecondaryWorkspaceInstanceReadOnly()) return;
    try {
      const provider = await deps.tryAuthenticatedProvider();
      if (!provider) return;
      const gc = await deps.globalConfig.load();

      const mode = vscode.workspace
        .getConfiguration("vscodesync")
        .get<string>("smartConflictPrediction.broadcastCurrentEditing", "full");
      const broadcastMode: CurrentEditingMode =
        mode === "anonymised" || mode === "off" ? mode : "full";
      const nowMs = Date.now();
      const tracked = broadcastMode === "off" ? null : await resolveActiveTrackedFile();
      const next = tracked
        ? buildCurrentEditingFrame({
            workspaceId: tracked.workspaceId,
            relPath: tracked.relPath,
            nowMs,
            mode: broadcastMode,
          })
        : null;
      const broadcast = shouldBroadcastCurrentEditing({
        last: lastBroadcastFrame,
        next,
        nowMs,
      });
      if (broadcast) {
        await syncMachinesRegistrySelf(provider, gc.machineId, gc.machineName, {
          currentEditing: next,
        });
        lastBroadcastFrame = next;
      } else {
        await syncMachinesRegistrySelf(provider, gc.machineId, gc.machineName);
      }
      verboseLog("presence", "heartbeat ok");
    } catch (e: unknown) {
      warnLog("presence", `heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.presenceHeartbeatMinutes")) {
        reschedule();
      }
    }),
    new vscode.Disposable(() => {
      if (timer !== undefined) clearInterval(timer);
    }),
  );

  reschedule();
}
