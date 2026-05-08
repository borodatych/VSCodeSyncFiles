import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { readSnoozeMap, setSnoozeEntry } from "../utils/snoozeStore.js";
import { isInactiveSnoozeActive } from "../core/inactiveWorkspaceCandidates.js";

const CFG = "vscodesync";
const PROMPT_HANDLED_KEY = "vscodesync.machineApprovalHandledIds";
const SNOOZE_UNTIL_KEY = "vscodesync.machineApprovalSnoozeUntilIso";
const POLL_MS = 75_000;

/** In-flight modal ids — avoid overlapping prompts from concurrent ticks. */
const showingPromptFor = new Set<string>();

function composePromptId(workspaceRootFsPath: string, workspaceId: string, remoteMachineId: string): string {
  return `${workspaceRootFsPath}\u0000${workspaceId}\u0000${remoteMachineId}`;
}

function loadHandledSet(ctx: vscode.ExtensionContext): Set<string> {
  const raw = ctx.globalState.get<string[]>(PROMPT_HANDLED_KEY);
  return new Set(Array.isArray(raw) ? raw : []);
}

async function rememberHandled(ctx: vscode.ExtensionContext, id: string): Promise<void> {
  const s = loadHandledSet(ctx);
  if (s.has(id)) {
    return;
  }
  s.add(id);
  await ctx.globalState.update(PROMPT_HANDLED_KEY, [...s]);
}

async function snoozeUntil(ctx: vscode.ExtensionContext, id: string, msFromNow: number): Promise<void> {
  const until = new Date(Date.now() + msFromNow).toISOString();
  await setSnoozeEntry(ctx, SNOOZE_UNTIL_KEY, id, until);
}

function isSnoozed(ctx: vscode.ExtensionContext, id: string): boolean {
  return isInactiveSnoozeActive(readSnoozeMap(ctx, SNOOZE_UNTIL_KEY)[id], Date.now());
}

export interface MachineApprovalNotifierDeps {
  extensionContext: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  getEncKey: () => Promise<Buffer | null>;
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    encKey?: Buffer | null,
  ) => SyncEngine;
  startupChannel?: vscode.OutputChannel;
}

async function pollOnce(deps: MachineApprovalNotifierDeps): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }
  const gc = await deps.globalConfig.load();
  if (!gc.onboardingCompleted) {
    return;
  }
  const vscodeCfg = vscode.workspace.getConfiguration(CFG);
  if (!vscodeCfg.get<boolean>("requireMachineApproval", false)) {
    return;
  }
  const provider = await deps.tryAuthenticatedProvider();
  if (!provider) {
    return;
  }
  const encKey = await deps.getEncKey();
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const wc = await WorkspaceConfigManager.load(root);
    const engine = deps.makeEngine(root, provider, gc.machineId, gc.machineName, encKey);

    for (const aw of wc.activeWorkspaces) {
      let machines;
      try {
        machines = await engine.getWorkspaceManifestMachines(aw.workspaceId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.startupChannel?.appendLine(`Machine approval poll (${aw.workspaceId}): ${msg}`);
        continue;
      }
      for (const row of machines) {
        if (row.machineId === gc.machineId) {
          continue;
        }
        if (row.status !== "pending") {
          continue;
        }
        const pid = composePromptId(root, aw.workspaceId, row.machineId);
        if (loadHandledSet(deps.extensionContext).has(pid)) {
          continue;
        }
        if (isSnoozed(deps.extensionContext, pid)) {
          continue;
        }
        if (showingPromptFor.has(pid)) {
          continue;
        }
        showingPromptFor.add(pid);
        try {
          const note = aw.workspaceNote.trim() || aw.workspaceId;
          const picked = await vscode.window.showWarningMessage(
            `VSCodeSync: новая машина «${row.machineName}» подключилась к workspace «${note}». Разрешить?`,
            "Разрешить",
            "Заблокировать",
            "Позже",
          );
          if (picked === undefined || picked === "Позже") {
            await snoozeUntil(deps.extensionContext, pid, 24 * 3600_000);
            continue;
          }
          await engine.setMachineManifestStatus(
            aw.workspaceId,
            row.machineId,
            picked === "Разрешить" ? "active" : "blocked",
          );
          await rememberHandled(deps.extensionContext, pid);
          await vscode.window.showInformationMessage(
            picked === "Разрешить"
              ? `VSCodeSync: машина «${row.machineName}» одобрена (active).`
              : `VSCodeSync: машина «${row.machineName}» заблокирована.`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          deps.startupChannel?.appendLine(`Machine approval (${aw.workspaceId}): ${msg}`);
          await vscode.window.showErrorMessage(`VSCodeSync: не удалось обновить манифест — ${msg}`);
        } finally {
          showingPromptFor.delete(pid);
        }
      }
    }
  }
}

export function scheduleMachineApprovalNotifier(context: vscode.ExtensionContext, deps: MachineApprovalNotifierDeps): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = (): void => {
    void pollOnce(deps).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      deps.startupChannel?.appendLine(`Machine approval notifier: ${msg}`);
    });
  };
  const handle = setTimeout(() => {
    tick();
    timer = setInterval(tick, POLL_MS);
  }, 28_000);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(handle);
      if (timer !== undefined) {
        clearInterval(timer);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CFG}.requireMachineApproval`)) {
        tick();
      }
    }),
  );
}
