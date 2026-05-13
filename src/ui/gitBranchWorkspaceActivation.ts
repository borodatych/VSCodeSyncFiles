import * as vscode from "vscode";
import * as fsp from "node:fs/promises";
import { watch } from "node:fs";
import * as path from "node:path";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { SyncEngine } from "../core/syncEngine.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { WorkspaceConfig } from "../core/types.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { allowImmediateOfflineFlushRetry, bumpOfflineFlushBackoff } from "../core/syncOfflineFlushBackoff.js";

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
  getEncKey: () => Promise<Buffer | null>;
  makeEngine: (
    root: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    encKey?: Buffer | null,
  ) => SyncEngine;
  offlineQueue?: SyncOfflineQueueStore;
  refreshUi: () => void | Promise<void>;
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export async function applyBranchPolicyForRoot(root: string, deps: GitBranchAutoActivationDeps): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }
  const enabled = vscode.workspace.getConfiguration(CFG).get<boolean>("gitBranchAutoSync", true);
  if (!enabled) {
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
  const encKey = await deps.getEncKey();
  const engine = deps.makeEngine(root, provider, gc.machineId, gc.machineName, encKey);

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
    const dirty = dirtyFilesForWorkspace(wc, wsId);
    if (dirty.length > 0) {
      const note = entry.workspaceNote;
      const fileList = dirty.map((f) => f.localPath).slice(0, 5).join(", ");
      const more = dirty.length > 5 ? ` … +${String(dirty.length - 5)}` : "";
      const picked = await vscode.window.showWarningMessage(
        `VSCodeSync: workspace «${note}» будет приостановлен (git-ветка не совпадает). Есть несинхронизированные изменения.`,
        {
          modal: true,
          detail: `Файлы: ${fileList}${more}`,
        },
        "Push и Suspend",
        "Suspend без push",
        "Отмена",
      );
      if (picked === "Отмена" || picked === undefined) {
        return;
      }
      if (picked === "Push и Suspend") {
        await engine.syncWorkspace(wsId);
      } else {
        for (const f of dirty) {
          await deps.offlineQueue?.enqueuePush(root, f.localPath, wsId);
        }
        if (deps.offlineQueue) {
          bumpOfflineFlushBackoff();
          allowImmediateOfflineFlushRetry();
        }
      }
    }
    await engine.setWorkspaceSyncState(wsId, "suspended");
  }

  for (const wsId of toActivate) {
    const status = await engine.getSelfMachineStatusInManifest(wsId);
    if (status === "blocked") {
      await vscode.window.showWarningMessage(
        `VSCodeSync: workspace не активирован по ветке — машина «blocked» в манифесте.`,
      );
      continue;
    }
    if (status === "pending") {
      await vscode.window.showInformationMessage(
        `VSCodeSync: workspace активирован по ветке в режиме только чтения: эта машина ожидает подтверждения в манифесте — push отключён до одобрения на другой машине.`,
      );
      const wc = await WorkspaceConfigManager.load(root);
      const entry = wc.activeWorkspaces.find((e) => e.workspaceId === wsId);
      if (entry && normalizeWorkspaceSyncState(entry) !== "active") {
        await engine.setWorkspaceSyncState(wsId, "active");
      }
      await engine.pullAll(wsId);
      continue;
    }
    const wc = await WorkspaceConfigManager.load(root);
    const entry = wc.activeWorkspaces.find((e) => e.workspaceId === wsId);
    if (entry && normalizeWorkspaceSyncState(entry) !== "active") {
      await engine.setWorkspaceSyncState(wsId, "active");
    }
    // Preview accumulated changes before syncing on Resume
    const showPreview = vscode.workspace.getConfiguration(CFG).get<boolean>("showPreview", true);
    if (showPreview) {
      try {
        const plan = await engine.previewSyncPlan(wsId);
        const ws = plan.find((w) => w.workspaceId === wsId);
        const files = ws?.files ?? [];
        const pullCount = files.filter((f) => f.action === "pull").length;
        const pushCount = files.filter((f) => f.action === "push").length;
        const conflictCount = files.filter((f) => f.action === "conflict_pending").length;
        const wsNote = entry?.workspaceNote ?? wsId;
        if (pullCount + pushCount + conflictCount > 0) {
          const picked = await vscode.window.showInformationMessage(
            `VSCodeSync: workspace «${wsNote}» активирован по ветке. Накоплено: ↓${String(pullCount)} pull · ↑${String(pushCount)} push · ⚠${String(conflictCount)} конфликтов.`,
            "Синхронизировать",
            "Позже",
          );
          if (picked !== "Синхронизировать") {
            await deps.refreshUi();
            continue;
          }
        }
      } catch {
        // Preview non-fatal — proceed with sync anyway
      }
    }
    await engine.syncWorkspace(wsId);
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
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void applyBranchPolicyForRoot(root, deps);
    }, 400);
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
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void attach();
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        void applyBranchPolicyForRoot(folder.uri.fsPath, deps);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CFG}.gitBranchAutoSync`)) {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          void applyBranchPolicyForRoot(folder.uri.fsPath, deps);
        }
      }
    }),
  );

  void attach();

  for (const f of vscode.workspace.workspaceFolders ?? []) {
    void applyBranchPolicyForRoot(f.uri.fsPath, deps);
  }
}
