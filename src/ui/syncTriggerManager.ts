import * as vscode from "vscode";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { absoluteToTrackedPosix, trackedLocalAbsolutePath } from "../core/pathMapping.js";
import type { SyncEngine } from "../core/syncEngine.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { isIgnoredSyncTriggerPath, resolveSaveDebounceMs } from "../core/syncTriggerLogic.js";
import type { SyncScheduleDeferredStore } from "../core/syncScheduleDeferredStore.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { subscribeSyncFileLock } from "../core/syncFileLock.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { fileLooksBinary } from "../utils/binaryDetect.js";
import type { SyncStatusBarController } from "./statusBar.js";
import { runQuietFullSyncAllFolders } from "./quietFullSyncAllFolders.js";
import { isAutoSyncBlockedBySchedule } from "./syncScheduleGate.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "../core/syncWorkspaceInstanceReadOnly.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { isLikelyUnreachableError } from "../utils/networkErrors.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import {
  allowImmediateOfflineFlushRetry,
  bumpOfflineFlushBackoff,
} from "../core/syncOfflineFlushBackoff.js";
import { noteCloudTransportFailure } from "../core/syncOfflineHints.js";
import { verboseLog } from "../utils/log.js";

const CFG = "vscodesync";
const GIT_EXT = "vscode.git";

const execFileAsync = promisify(execFile);

export interface SyncTriggerManagerDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  makeEngine: (root: string, provider: ICloudProvider, machineId: string, machineName: string) => SyncEngine;
  statusBar: Pick<SyncStatusBarController, "setSyncing" | "refresh">;
  refreshUi: () => void;
  scheduleDeferred: SyncScheduleDeferredStore;
  offlineQueue: SyncOfflineQueueStore;
}

interface GitApiLike {
  repositories: GitRepoLike[];
  onDidOpenRepository: vscode.Event<GitRepoLike>;
}

interface GitRepoLike {
  readonly rootUri: vscode.Uri;
  readonly state: { HEAD?: { commit?: string } };
  // VS Code Git API Repository exposes `onDidChange`, not `onDidChangeState`
  // (see extensions/git/src/api/git.d.ts: Repository.onDidChange).
  readonly onDidChange: vscode.Event<void>;
}

interface GitExtLike {
  getAPI(version: 1): GitApiLike;
}

type EngineUnreachableEnqueue =
  | { kind: "none" }
  | { kind: "push"; rel: string; workspaceId: string }
  | { kind: "pull"; rel: string; workspaceId: string }
  | { kind: "fullSync" };

/**
 * Subscribes VS Code events: onSave (debounced per workspace saveDebounceSec), window focus (full sync after delay),
 * document open (pull if syncOnOpen), Git post-commit (push tracked paths when pushOnCommit).
 */
export function registerSyncTriggerManager(context: vscode.ExtensionContext, deps: SyncTriggerManagerDeps): void {
  let chain: Promise<void> = Promise.resolve();
  const serialize = (fn: () => Promise<void>): void => {
    chain = chain.then(fn, fn).then(
      () => undefined,
      () => undefined,
    );
  };

  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let focusTimer: ReturnType<typeof setTimeout> | undefined;

  const clearSaveDebounceForFile = (normalizedAbsLower: string): void => {
    const target = normalizedAbsLower;
    for (const [k, tid] of [...saveTimers.entries()]) {
      const nk = path.normalize(k).replace(/\\/g, "/").toLowerCase();
      if (nk === target) {
        clearTimeout(tid);
        saveTimers.delete(k);
      }
    }
  };

  context.subscriptions.push(
    new vscode.Disposable(
      subscribeSyncFileLock((ev) => {
        if (ev.type !== "enter" || ev.op !== "pull") {
          return;
        }
        void (async () => {
          const gc = await deps.globalConfig.load();
          const cfg = await WorkspaceConfigManager.load(ev.workspaceRoot);
          let abs: string;
          try {
            abs = trackedLocalAbsolutePath(ev.workspaceRoot, cfg.pathMapping, gc.machineName, ev.posixRel);
          } catch {
            return;
          }
          clearSaveDebounceForFile(path.normalize(abs).replace(/\\/g, "/").toLowerCase());
        })();
      }),
    ),
  );

  const refreshAfter = async (): Promise<void> => {
    deps.refreshUi();
    await deps.statusBar.refresh();
  };

  let _trigSeq = 0;
  const withEngine = async (
    root: string,
    fn: (engine: SyncEngine) => Promise<void>,
    enqueueOnUnreachable: EngineUnreachableEnqueue = { kind: "none" },
  ): Promise<void> => {
    const seq = ++_trigSeq;
    const label = enqueueOnUnreachable.kind === "push"
      ? `push:${"rel" in enqueueOnUnreachable ? enqueueOnUnreachable.rel : "?"}`
      : enqueueOnUnreachable.kind === "pull"
        ? `pull:${"rel" in enqueueOnUnreachable ? enqueueOnUnreachable.rel : "?"}`
        : "fullSync";
    verboseLog("trigger", `#${String(seq)} START ${label}`);
    if (!vscode.workspace.isTrusted) {
      return;
    }
    if (syncSessionPause.isPaused()) {
      return;
    }
    if (syncAutoPause.isActive()) {
      return;
    }
    if (isAutoSyncBlockedByRateLimit()) {
      return;
    }
    const p = await deps.tryAuthenticatedProvider();
    if (!p) {
      return;
    }
    const mc = await deps.globalConfig.load();
    const engine = deps.makeEngine(root, p, mc.machineId, mc.machineName);
    deps.statusBar.setSyncing(true);
    try {
      await fn(engine);
    } catch (e: unknown) {
      if (enqueueOnUnreachable.kind !== "none" && isLikelyUnreachableError(e)) {
        bumpOfflineFlushBackoff();
        noteCloudTransportFailure();
        if (enqueueOnUnreachable.kind === "fullSync") {
          await deps.offlineQueue.enqueueFullSync();
        } else if (enqueueOnUnreachable.kind === "push") {
          await deps.offlineQueue.enqueuePush(root, enqueueOnUnreachable.rel, enqueueOnUnreachable.workspaceId);
        } else {
          await deps.offlineQueue.enqueuePull(root, enqueueOnUnreachable.rel, enqueueOnUnreachable.workspaceId);
        }
        allowImmediateOfflineFlushRetry();
        await deps.statusBar.refresh();
      } else if (e instanceof ProviderError && e.code === "UNAUTHORIZED") {
        // Auth expired during auto-trigger: queue for retry after user re-authenticates.
        await deps.offlineQueue.enqueueFullSync();
        allowImmediateOfflineFlushRetry();
        await deps.statusBar.refresh();
      }
    } finally {
      verboseLog("trigger", `#${String(seq)} finally ${label}`);
      deps.statusBar.setSyncing(false);
      await refreshAfter();
    }
  };

  const runFocusSyncAll = async (): Promise<void> => {
    await runQuietFullSyncAllFolders({
      globalConfig: deps.globalConfig,
      tryAuthenticatedProvider: deps.tryAuthenticatedProvider,
      makeEngine: deps.makeEngine,
      statusBar: deps.statusBar,
      offlineQueue: deps.offlineQueue,
      refreshUi: deps.refreshUi,
    });
  };

  const pushAfterSave = async (root: string, rel: string, workspaceId: string): Promise<void> => {
    if (isSecondaryWorkspaceInstanceReadOnly()) {
      return;
    }
    const warnBin = vscode.workspace.getConfiguration(CFG).get<boolean>("warnOnBinaryFiles", true);
    const abs = path.join(root, ...rel.split("/"));
    if (warnBin && (await fileLooksBinary(abs))) {
      return;
    }
    await withEngine(
      root,
      async (engine) => {
        const cfg = await WorkspaceConfigManager.load(root);
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
        if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
          return;
        }
        const fe = cfg.files.find((f) => f.localPath === rel && f.workspaceId === workspaceId);
        if (!fe || fe.syncStatus === "conflict" || fe.editingBy) {
          return;
        }
        await engine.pushFile(cfg, workspaceId, rel, entry);
        await WorkspaceConfigManager.save(cfg, root);
      },
      { kind: "push", rel, workspaceId },
    );
  };

  const pullOnOpen = async (root: string, rel: string, workspaceId: string): Promise<void> => {
    await withEngine(
      root,
      async (engine) => {
        const cfg = await WorkspaceConfigManager.load(root);
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
        if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
          return;
        }
        const fe = cfg.files.find((f) => f.localPath === rel && f.workspaceId === workspaceId);
        if (!fe || fe.syncStatus === "conflict") {
          return;
        }
        await engine.pullFile(cfg, workspaceId, rel, entry);
        await WorkspaceConfigManager.save(cfg, root);
      },
      { kind: "pull", rel, workspaceId },
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file") {
        return;
      }
      if (isIgnoredSyncTriggerPath(doc.uri.fsPath)) {
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder) {
        return;
      }
      void (async () => {
        if (syncSessionPause.isPaused()) {
          syncSessionPause.notePendingDocSave(doc.uri.fsPath);
          return;
        }
        const gc = await deps.globalConfig.load();
        const cfg = await WorkspaceConfigManager.load(folder.uri.fsPath);
        let rel: string;
        try {
          rel = absoluteToTrackedPosix(folder.uri.fsPath, cfg.pathMapping, gc.machineName, doc.uri.fsPath);
        } catch {
          return;
        }
        const fileEntry = cfg.files.find((f) => f.localPath === rel);
        if (!fileEntry) {
          return;
        }
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === fileEntry.workspaceId);
        if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
          return;
        }
        if (fileEntry.syncStatus === "conflict" || fileEntry.editingBy) {
          return;
        }
        if (syncAutoPause.isActive()) {
          await deps.statusBar.refresh();
          return;
        }
        if (isAutoSyncBlockedBySchedule()) {
          await deps.scheduleDeferred.enqueuePush(folder.uri.fsPath, rel, fileEntry.workspaceId);
          await deps.statusBar.refresh();
          return;
        }
        const ms = resolveSaveDebounceMs(entry);
        const key = doc.uri.fsPath;
        const prev = saveTimers.get(key);
        if (prev !== undefined) {
          clearTimeout(prev);
        }
        const tid = setTimeout(() => {
          saveTimers.delete(key);
          serialize(() => pushAfterSave(folder.uri.fsPath, rel, fileEntry.workspaceId));
        }, ms);
        saveTimers.set(key, tid);
      })();
    }),

    vscode.window.onDidChangeWindowState((s) => {
      if (focusTimer !== undefined) {
        clearTimeout(focusTimer);
        focusTimer = undefined;
      }
      if (!s.focused) {
        return;
      }
      if (syncSessionPause.isPaused()) {
        return;
      }
      const delay = vscode.workspace.getConfiguration(CFG).get<number>("syncOnFocusDelayMs", 3000);
      focusTimer = setTimeout(() => {
        focusTimer = undefined;
        if (!vscode.window.state.focused) {
          return;
        }
        serialize(async () => {
          if (syncSessionPause.isPaused()) {
            return;
          }
          if (syncAutoPause.isActive()) {
            await deps.statusBar.refresh();
            return;
          }
          if (isAutoSyncBlockedBySchedule()) {
            await deps.scheduleDeferred.enqueueFullSync();
            await deps.statusBar.refresh();
            return;
          }
          await runFocusSyncAll();
        });
      }, Math.max(0, delay));
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "file") {
        return;
      }
      if (isIgnoredSyncTriggerPath(doc.uri.fsPath)) {
        return;
      }
      const conf = vscode.workspace.getConfiguration(CFG);
      if (!conf.get<boolean>("syncOnOpen", true)) {
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder) {
        return;
      }
      void (async () => {
        if (syncSessionPause.isPaused()) {
          return;
        }
        const gc = await deps.globalConfig.load();
        const cfg = await WorkspaceConfigManager.load(folder.uri.fsPath);
        let rel: string;
        try {
          rel = absoluteToTrackedPosix(folder.uri.fsPath, cfg.pathMapping, gc.machineName, doc.uri.fsPath);
        } catch {
          return;
        }
        const fileEntry = cfg.files.find((f) => f.localPath === rel);
        if (!fileEntry) {
          return;
        }
        const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === fileEntry.workspaceId);
        if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
          return;
        }
        if (fileEntry.syncStatus === "conflict") {
          return;
        }
        if (syncAutoPause.isActive()) {
          await deps.statusBar.refresh();
          return;
        }
        if (isAutoSyncBlockedBySchedule()) {
          await deps.scheduleDeferred.enqueuePull(folder.uri.fsPath, rel, fileEntry.workspaceId);
          await deps.statusBar.refresh();
          return;
        }
        serialize(() => pullOnOpen(folder.uri.fsPath, rel, fileEntry.workspaceId));
      })();
    }),

    new vscode.Disposable(() => {
      for (const t of saveTimers.values()) {
        clearTimeout(t);
      }
      saveTimers.clear();
      if (focusTimer !== undefined) {
        clearTimeout(focusTimer);
      }
    }),
  );

  registerGitPushOnCommit(context, deps, serialize, withEngine);
}

async function gitFilesInCommit(repoRoot: string, commitHash: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", commitHash],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function enqueueDeferredGitPushesForRepo(
  deps: SyncTriggerManagerDeps,
  workspaceFolderRoot: string,
  gitRepoRoot: string,
  committedRelToGit: string[],
): Promise<void> {
  if (isSecondaryWorkspaceInstanceReadOnly()) {
    return;
  }
  const normFolder = workspaceFolderRoot.replace(/\\/g, "/").toLowerCase();
  const normGit = gitRepoRoot.replace(/\\/g, "/").toLowerCase();
  if (!normFolder.startsWith(normGit) && !normGit.startsWith(normFolder)) {
    return;
  }

  const cfg = await WorkspaceConfigManager.load(workspaceFolderRoot);
  const gc = await deps.globalConfig.load();
  for (const gitRel of committedRelToGit) {
    const abs = path.normalize(path.join(gitRepoRoot, gitRel.split("/").join(path.sep)));
    const normAbs = abs.replace(/\\/g, "/").toLowerCase();
    if (!normAbs.startsWith(normFolder)) {
      continue;
    }
    let relW: string;
    try {
      relW = absoluteToTrackedPosix(workspaceFolderRoot, cfg.pathMapping, gc.machineName, abs);
    } catch {
      continue;
    }
    const fe = cfg.files.find((f) => f.localPath === relW);
    if (!fe || fe.syncStatus === "conflict" || fe.editingBy) {
      continue;
    }
    const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === fe.workspaceId);
    if (!ent || normalizeWorkspaceSyncState(ent) !== "active") {
      continue;
    }
    await deps.scheduleDeferred.enqueuePush(workspaceFolderRoot, relW, fe.workspaceId);
  }
}

function registerGitPushOnCommit(
  context: vscode.ExtensionContext,
  deps: SyncTriggerManagerDeps,
  serialize: (fn: () => Promise<void>) => void,
  withEngine: (
    root: string,
    fn: (engine: SyncEngine) => Promise<void>,
    enqueue?: EngineUnreachableEnqueue,
  ) => Promise<void>,
): void {
  const lastHeadByRepo = new Map<string, string | undefined>();
  const disposables: vscode.Disposable[] = [];

  const bindRepo = (repo: GitRepoLike): void => {
    lastHeadByRepo.set(repo.rootUri.fsPath, repo.state.HEAD?.commit);
    disposables.push(
      repo.onDidChange(() => {
        void (async () => {
          const head = repo.state.HEAD?.commit;
          const repoRoot = repo.rootUri.fsPath;
          const prev = lastHeadByRepo.get(repoRoot);
          lastHeadByRepo.set(repoRoot, head);
          if (head === undefined || head === prev) {
            return;
          }
          if (prev === undefined) {
            return;
          }
          if (syncSessionPause.isPaused()) {
            return;
          }
          if (!vscode.workspace.getConfiguration(CFG).get<boolean>("pushOnCommit", false)) {
            return;
          }
          const relPaths = await gitFilesInCommit(repoRoot, head);
          if (relPaths.length === 0) {
            return;
          }
          const warnBin = vscode.workspace.getConfiguration(CFG).get<boolean>("warnOnBinaryFiles", true);

          if (syncAutoPause.isActive()) {
            return;
          }
          if (isAutoSyncBlockedBySchedule()) {
            serialize(async () => {
              const folders = vscode.workspace.workspaceFolders ?? [];
              for (const folder of folders) {
                await enqueueDeferredGitPushesForRepo(deps, folder.uri.fsPath, repoRoot, relPaths);
              }
              await deps.statusBar.refresh();
            });
            return;
          }

          serialize(async () => {
            const folders = vscode.workspace.workspaceFolders ?? [];
            for (const folder of folders) {
              await maybePushCommittedFilesForFolder(deps, folder.uri.fsPath, repoRoot, relPaths, warnBin, withEngine);
            }
          });
        })();
      }),
    );
  };

  (async () => {
    try {
      const ext = vscode.extensions.getExtension<GitExtLike>(GIT_EXT);
      if (!ext) {
        return;
      }
      await ext.activate();
      const api = ext.exports.getAPI(1);
      for (const r of api.repositories) {
        bindRepo(r);
      }
      disposables.push(
        api.onDidOpenRepository((r) => {
          bindRepo(r);
        }),
      );
    } catch {
      /* Git extension unavailable */
    }
  })().catch(() => {
    /* ignore */
  });

  context.subscriptions.push(
    new vscode.Disposable(() => {
      for (const d of disposables) {
        d.dispose();
      }
      disposables.length = 0;
    }),
  );
}

async function maybePushCommittedFilesForFolder(
  deps: SyncTriggerManagerDeps,
  workspaceFolderRoot: string,
  gitRepoRoot: string,
  committedRelToGit: string[],
  warnOnBinary: boolean,
  withEngine: (
    root: string,
    fn: (engine: SyncEngine) => Promise<void>,
    enqueue?: EngineUnreachableEnqueue,
  ) => Promise<void>,
): Promise<void> {
  if (isSecondaryWorkspaceInstanceReadOnly()) {
    return;
  }
  const normFolder = workspaceFolderRoot.replace(/\\/g, "/").toLowerCase();
  const normGit = gitRepoRoot.replace(/\\/g, "/").toLowerCase();
  if (!normFolder.startsWith(normGit) && !normGit.startsWith(normFolder)) {
    return;
  }

  const trackedToPush: { relW: string; wsId: string }[] = [];
  const cfg = await WorkspaceConfigManager.load(workspaceFolderRoot);
  const gc = await deps.globalConfig.load();
  for (const gitRel of committedRelToGit) {
    const abs = path.normalize(path.join(gitRepoRoot, gitRel.split("/").join(path.sep)));
    const normAbs = abs.replace(/\\/g, "/").toLowerCase();
    if (!normAbs.startsWith(normFolder)) {
      continue;
    }
    let relW: string;
    try {
      relW = absoluteToTrackedPosix(workspaceFolderRoot, cfg.pathMapping, gc.machineName, abs);
    } catch {
      continue;
    }
    const fe = cfg.files.find((f) => f.localPath === relW);
    if (!fe || fe.syncStatus === "conflict" || fe.editingBy) {
      continue;
    }
    const ent = cfg.activeWorkspaces.find((w) => w.workspaceId === fe.workspaceId);
    if (!ent || normalizeWorkspaceSyncState(ent) !== "active") {
      continue;
    }
    if (warnOnBinary && (await fileLooksBinary(abs))) {
      continue;
    }
    trackedToPush.push({ relW, wsId: fe.workspaceId });
  }

  if (trackedToPush.length === 0) {
    return;
  }

  let sawUnreachable = false;
  await withEngine(workspaceFolderRoot, async (engine) => {
    const fresh = await WorkspaceConfigManager.load(workspaceFolderRoot);
    for (const row of trackedToPush) {
      const entry = fresh.activeWorkspaces.find((w) => w.workspaceId === row.wsId);
      if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
        continue;
      }
      const fe = fresh.files.find((f) => f.localPath === row.relW && f.workspaceId === row.wsId);
      if (!fe || fe.syncStatus === "conflict" || fe.editingBy) {
        continue;
      }
      try {
        await engine.pushFile(fresh, row.wsId, row.relW, entry, { pushOnCommit: true });
        await WorkspaceConfigManager.save(fresh, workspaceFolderRoot);
      } catch (e) {
        if (isLikelyUnreachableError(e)) {
          sawUnreachable = true;
        }
      }
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- sawUnreachable set in catch when transport fails
  if (sawUnreachable) {
    bumpOfflineFlushBackoff();
    noteCloudTransportFailure();
    await deps.offlineQueue.enqueueFullSync();
    allowImmediateOfflineFlushRetry();
    await deps.statusBar.refresh();
  }
}
