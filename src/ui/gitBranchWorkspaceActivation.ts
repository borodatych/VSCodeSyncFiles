import * as vscode from "vscode";
import * as fsp from "node:fs/promises";
import { watch } from "node:fs";
import * as path from "node:path";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { WorkspaceConfig } from "../core/types.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { isAutoCheckEnabled, parseAutoSyncMode } from "../core/autoSyncMode.js";
import { warnLog } from "../utils/log.js";

const CFG = "vscodesync";

/** Normalize branch names for comparison with manifest `gitBranch`. */
export function normalizeGitBranchRef(name: string): string {
  const t = name.trim();
  if (t.startsWith("refs/heads/")) {
    return t.slice("refs/heads/".length);
  }
  if (t.startsWith("refs/remotes/")) {
    const rest = t.slice("refs/remotes/".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? rest.slice(slash + 1) : rest;
  }
  return t;
}

interface GitRepositoryLike {
  readonly rootUri: vscode.Uri;
  readonly state: {
    HEAD?: { name?: string };
    readonly onDidChange: vscode.Event<void>;
  };
}

interface GitAPILike {
  getRepository(uri: vscode.Uri): GitRepositoryLike | null | undefined;
}

async function getGitAPI(): Promise<GitAPILike | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPILike }>("vscode.git");
  if (!ext) {
    return undefined;
  }
  try {
    const ex: { getAPI(version: 1): GitAPILike } = ext.isActive ? ext.exports : await ext.activate();
    return ex.getAPI(1);
  } catch {
    return undefined;
  }
}

function dirtyFilesForWorkspace(wc: WorkspaceConfig, workspaceId: string) {
  return wc.files.filter(
    (f) =>
      f.workspaceId === workspaceId &&
      (f.syncStatus === "pending_push" || f.syncStatus === "conflict"),
  );
}

export interface GitBranchAutoActivationDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  makeEngine: (
    root: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
  refreshUi: () => void | Promise<void>;
}

/**
 * Per-root debounce. A single shared timer meant that in a multi-root window a
 * HEAD change in folder A cancelled the policy pass scheduled for folder B.
 */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A branch switch is an automatic event (B1): it may switch `syncState` and
 * recount statuses, and it may *offer* data movement — never perform it. Every
 * engine call in this pass runs under `trigger: "auto"`; the toast buttons
 * build a fresh `"user"` engine, because the click is the consent.
 *
 * This file used to be the main violator of "nothing without asking":
 * `pullAll` ran unconditionally for a pending machine, `syncWorkspace` ran
 * when the preview was disabled, empty — or *failed* ("proceed with sync
 * anyway"), and none of it consulted `autoSyncMode`.
 */
export async function applyBranchPolicyForRoot(root: string, deps: GitBranchAutoActivationDeps): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }
  const enabled = vscode.workspace.getConfiguration(CFG).get<boolean>("gitBranchAutoSync", true);
  if (!enabled) {
    return;
  }
  // `off` promises silence — no provider round-trips from a branch switch.
  const autoMode = parseAutoSyncMode(
    vscode.workspace.getConfiguration(CFG).get<string>("autoSyncMode", "check-only"),
  );
  if (!isAutoCheckEnabled(autoMode)) {
    return;
  }
  const wc0 = await WorkspaceConfigManager.load(root);
  if (wc0.activeWorkspaces.length === 0) {
    return;
  }
  const git = await getGitAPI();
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  let currentBranch: string | undefined;
  if (git && folder) {
    const repo = git.getRepository(folder.uri);
    const headName = repo?.state.HEAD?.name;
    if (headName !== undefined && headName !== "") {
      currentBranch = normalizeGitBranchRef(headName);
    }
  }
  if (currentBranch === undefined) {
    return;
  }

  const provider = await deps.tryAuthenticatedProvider();
  if (!provider) {
    return;
  }
  const gc = await deps.globalConfig.load();
  const engine = deps.makeEngine(root, provider, gc.machineId, gc.machineName, "auto");
  // Built on click, not in advance: the button press is what makes it "user".
  const userEngine = (): SyncEngine =>
    deps.makeEngine(root, provider, gc.machineId, gc.machineName, "user");

  const toSuspend: string[] = [];
  const toActivate: string[] = [];

  for (const aw of wc0.activeWorkspaces) {
    const bound = aw.gitBranch?.trim();
    if (bound === undefined || bound === "") {
      continue;
    }
    const nb = normalizeGitBranchRef(bound);
    if (nb === currentBranch) {
      toActivate.push(aw.workspaceId);
    } else {
      toSuspend.push(aw.workspaceId);
    }
  }

  for (const wsId of toSuspend) {
    const wc = await WorkspaceConfigManager.load(root);
    const entry = wc.activeWorkspaces.find((e) => e.workspaceId === wsId);
    if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
      continue;
    }
    // Suspend first, unconditionally: the branch no longer matches, so the
    // workspace must stop syncing regardless of what the user decides about
    // the leftover changes. The old modal ("Push и Suspend / Suspend без
    // push / Отмена") blocked this pass inside a background event and could
    // cancel the suspension itself.
    await engine.setWorkspaceSyncState(wsId, "suspended");
    const dirty = dirtyFilesForWorkspace(wc, wsId);
    if (dirty.length > 0) {
      const note = entry.workspaceNote.trim() || wsId;
      void (async () => {
        const picked = await vscode.window.showInformationMessage(
          `VSCodeSync: workspace «${note}» приостановлен (git-ветка не совпадает). ` +
            `Несинхронизированных изменений: ${String(dirty.length)}.`,
          "Отправить",
          "Показать",
        );
        if (picked === "Отправить") {
          try {
            await userEngine().pushAll(wsId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            void vscode.window.showErrorMessage(`VSCodeSync: отправка «${note}» — ${msg}`);
          }
          await deps.refreshUi();
        } else if (picked === "Показать") {
          void vscode.commands.executeCommand("vscodesync.previewSync");
        }
      })();
    }
  }

  for (const wsId of toActivate) {
    const status = await engine.getSelfMachineStatusInManifest(wsId);
    if (status === "blocked") {
      await vscode.window.showWarningMessage(
        `VSCodeSync: workspace не активирован по ветке — машина «blocked» в манифесте.`,
      );
      continue;
    }
    const wc = await WorkspaceConfigManager.load(root);
    const entry = wc.activeWorkspaces.find((e) => e.workspaceId === wsId);
    if (entry && normalizeWorkspaceSyncState(entry) !== "active") {
      await engine.setWorkspaceSyncState(wsId, "active");
    }
    const wsNote = entry?.workspaceNote.trim() ?? wsId;
    if (status === "pending") {
      // This machine is read-only until approved. The old code pulled the
      // whole workspace right here, overwriting local files because git HEAD
      // moved — while the toast claimed "push отключён".
      void (async () => {
        const picked = await vscode.window.showInformationMessage(
          `VSCodeSync: workspace «${wsNote}» активирован по ветке в режиме только чтения — ` +
            "эта машина ожидает подтверждения в манифесте. Файлы не скачивались.",
          "Скачать всё",
        );
        if (picked === "Скачать всё") {
          try {
            await userEngine().pullAll(wsId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            void vscode.window.showErrorMessage(`VSCodeSync: скачивание «${wsNote}» — ${msg}`);
          }
          await deps.refreshUi();
        }
      })();
      continue;
    }
    // Recount statuses (detector) and offer the accumulated difference. The
    // preview failing is a reason to stay quiet, not to sync blindly — the
    // old fallback read "Preview non-fatal — proceed with sync anyway".
    try {
      await engine.checkWorkspaceStatus(wsId);
      const plan = await engine.previewSyncPlan(wsId);
      const ws = plan.find((w) => w.workspaceId === wsId);
      const files = ws?.files ?? [];
      const pullCount = files.filter((f) => f.action === "pull").length;
      const pushCount = files.filter((f) => f.action === "push").length;
      const conflictCount = files.filter((f) => f.action === "conflict_pending").length;
      if (pullCount + pushCount + conflictCount > 0) {
        void (async () => {
          const picked = await vscode.window.showInformationMessage(
            `VSCodeSync: workspace «${wsNote}» активирован по ветке. Накоплено: ` +
              `↓${String(pullCount)} pull · ↑${String(pushCount)} push · ⚠${String(conflictCount)} конфликтов.`,
            "Синхронизировать",
            "Позже",
          );
          if (picked === "Синхронизировать") {
            try {
              await userEngine().syncWorkspace(wsId);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              void vscode.window.showErrorMessage(`VSCodeSync: синхронизация «${wsNote}» — ${msg}`);
            }
            await deps.refreshUi();
          }
        })();
      }
    } catch (e) {
      warnLog("gitBranch", `status recount failed for ${wsId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await deps.refreshUi();
}

/**
 * When git HEAD changes: suspend workspace'ies bound to other branches; activate bound matches.
 * Uses built-in `vscode.git` API when available; falls back to `fs.watch` on `.git/HEAD`.
 */
export function registerGitBranchWorkspaceActivation(
  context: vscode.ExtensionContext,
  deps: GitBranchAutoActivationDeps,
): void {
  const folderListeners: vscode.Disposable[] = [];
  let attachGeneration = 0;

  const clearFolderListeners = (): void => {
    for (const d of folderListeners) {
      d.dispose();
    }
    folderListeners.length = 0;
  };

  const schedule = (root: string): void => {
    const prior = debounceTimers.get(root);
    if (prior !== undefined) {
      clearTimeout(prior);
    }
    debounceTimers.set(
      root,
      setTimeout(() => {
        debounceTimers.delete(root);
        void applyBranchPolicyForRoot(root, deps);
      }, 400),
    );
  };

  const attach = async (): Promise<void> => {
    attachGeneration += 1;
    const gen = attachGeneration;
    clearFolderListeners();
    const git = await getGitAPI();
    if (gen !== attachGeneration) {
      return;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      const repo = git?.getRepository(folder.uri);
      if (repo) {
        folderListeners.push(
          repo.state.onDidChange(() => {
            schedule(root);
          }),
        );
      } else {
        const headPath = path.join(root, ".git", "HEAD");
        try {
          await fsp.access(headPath);
          const w = watch(headPath, () => {
            schedule(root);
          });
          folderListeners.push(
            new vscode.Disposable(() => {
              w.close();
            }),
          );
        } catch {
          /* not a git repo */
        }
      }
    }
  };

  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearFolderListeners();
      for (const t of debounceTimers.values()) {
        clearTimeout(t);
      }
      debounceTimers.clear();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void attach();
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        schedule(folder.uri.fsPath);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CFG}.gitBranchAutoSync`)) {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          schedule(folder.uri.fsPath);
        }
      }
    }),
  );

  void attach();

  // Startup pass goes through the same debounce as everything else: the
  // activation itself is not a branch switch, so there is no reason for it to
  // race ahead of the listeners it just registered.
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    schedule(f.uri.fsPath);
  }
}
