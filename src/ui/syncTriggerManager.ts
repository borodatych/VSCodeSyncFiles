import * as vscode from "vscode";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { absoluteToTrackedPosix, trackedLocalAbsolutePath } from "../core/pathMapping.js";
import type { SyncEngine } from "../core/syncEngine.js";
import type { SyncTrigger } from "../core/syncPolicy.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import { isIgnoredSyncTriggerPath, resolveSaveDebounceMs } from "../core/syncTriggerLogic.js";
import { isAutoCheckEnabled, parseAutoSyncMode } from "../core/autoSyncMode.js";
import type { SyncScheduleDeferredStore } from "../core/syncScheduleDeferredStore.js";
import type { SyncOfflineQueueStore } from "../core/syncOfflineQueueStore.js";
import { subscribeSyncFileLock } from "../core/syncFileLock.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import type { SyncStatusBarController } from "./statusBar.js";
import { runQuietFullSyncAllFolders } from "./quietFullSyncAllFolders.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { isLikelyUnreachableError } from "../utils/networkErrors.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import {
  allowImmediateOfflineFlushRetry,
  bumpOfflineFlushBackoff,
} from "../core/syncOfflineFlushBackoff.js";
import { noteCloudTransportFailure } from "../core/syncOfflineHints.js";
import { verboseLog, warnLog } from "../utils/log.js";
import { createTriggerLanes, type TriggerLane } from "../core/syncTriggerLanes.js";

/**
 * Per-step backstop inside a trigger lane. A step that outlives this is assumed
 * wedged and its lane is released, so later triggers keep working instead of
 * queueing behind it forever. Above the file-lock hold deadline on purpose:
 * a legitimately slow operation should hit its own deadline, not this one.
 */
const TRIGGER_STEP_TIMEOUT_MS = 6 * 60_000;

const CFG = "vscodesync";
const GIT_EXT = "vscode.git";

/** v0.7 — read live setting `vscodesync.autoSyncMode`. */
function currentAutoSyncMode(): "off" | "check-only" {
  return parseAutoSyncMode(
    vscode.workspace.getConfiguration(CFG).get<string>("autoSyncMode", "check-only"),
  );
}

const execFileAsync = promisify(execFile);

export interface SyncTriggerManagerDeps {
  globalConfig: GlobalConfigManager;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  makeEngine: (root: string, provider: ICloudProvider, machineId: string, machineName: string, trigger: SyncTrigger) => SyncEngine;
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
  readonly state: {
    HEAD?: { commit?: string };
    readonly onDidChange: vscode.Event<void>;
  };
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
  // Trigger scheduling lives in `syncTriggerLanes` — pure and unit-tested there.
  // Everything used to share a single promise chain, so a full pass over every
  // workspace blocked the quick per-file push queued right after a save, and one
  // step that never settled froze every later trigger for the lifetime of the
  // window with the status bar stuck on "Синхронизация…".
  const lanes = createTriggerLanes({
    stepTimeoutMs: TRIGGER_STEP_TIMEOUT_MS,
    onStepTimeout: (label, ms) => {
      warnLog("trigger", `шаг "${label}" не завершился за ${String(ms)} мс — освобождаю очередь`);
    },
    onStepError: (label, e) => {
      verboseLog("trigger", `шаг "${label}" завершился ошибкой: ${e instanceof Error ? e.message : String(e)}`);
    },
    onFullSkipped: (label) => {
      verboseLog("trigger", `полный проход уже запланирован — пропускаю "${label}"`);
    },
  });

  const serializeIn = (lane: TriggerLane, fn: () => Promise<void>, label: string): void => {
    lanes.run(lane, fn, label);
  };

  const serialize = (fn: () => Promise<void>): void => {
    serializeIn("file", fn, "file-op");
  };

  /**
   * Pending debounced push per absolute path, together with the means to arm it
   * again. `rearm` matters: a pull entering the same file used to *delete* the
   * timer and stop there, so a file saved seconds before a background pull was
   * never pushed at all — no status, no log, nothing. That is the "sometimes it
   * just will not upload" report.
   */
  interface PendingSavePush {
    timer: ReturnType<typeof setTimeout>;
    rearm: () => void;
  }
  const saveTimers = new Map<string, PendingSavePush>();
  /** Pushes parked because a pull holds the file; re-armed when the pull leaves. */
  const parkedPushes = new Map<string, () => void>();
  let focusTimer: ReturnType<typeof setTimeout> | undefined;

  const normalizeAbs = (abs: string): string =>
    path.normalize(abs).replace(/\\/g, "/").toLowerCase();

  /** Park (do not drop) the debounced push for a file a pull is about to touch. */
  const parkSaveDebounceForFile = (normalizedAbsLower: string): void => {
    for (const [k, pending] of [...saveTimers.entries()]) {
      if (normalizeAbs(k) !== normalizedAbsLower) continue;
      clearTimeout(pending.timer);
      saveTimers.delete(k);
      parkedPushes.set(normalizedAbsLower, pending.rearm);
      verboseLog("trigger", `push отложен на время pull: ${k}`);
    }
  };

  /** Re-arm whatever the pull displaced, now that the file is free again. */
  const resumeParkedPushForFile = (normalizedAbsLower: string): void => {
    const rearm = parkedPushes.get(normalizedAbsLower);
    if (!rearm) return;
    parkedPushes.delete(normalizedAbsLower);
    verboseLog("trigger", `pull завершён — возвращаю отложенный push: ${normalizedAbsLower}`);
    rearm();
  };

  context.subscriptions.push(
    new vscode.Disposable(
      subscribeSyncFileLock((ev) => {
        if (ev.op !== "pull") {
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
          const key = normalizeAbs(abs);
          if (ev.type === "enter") {
            parkSaveDebounceForFile(key);
          } else {
            resumeParkedPushForFile(key);
          }
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
    const engine = deps.makeEngine(root, p, mc.machineId, mc.machineName, "auto");
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
      trigger: "auto",
    });
  };

  /**
   * Detector reaction shared by the save / open / commit triggers (stage 3.4).
   *
   * These used to call `pushFile` / `pullFile` when the mode was `full`; the
   * mode is gone, so the events recount the file's workspace instead — cheap
   * conditional GETs that refresh `syncStatus`, the tree and the panel. No
   * offline enqueue on failure: a status pass that could not run has nothing
   * to retry later, the next event recounts anyway.
   */
  const recountWorkspaceStatus = async (root: string, workspaceId: string): Promise<void> => {
    await withEngine(root, async (engine) => {
      const cfg = await WorkspaceConfigManager.load(root);
      const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
        return;
      }
      await engine.checkWorkspaceStatus(workspaceId);
    });
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file") {
        return;
      }
      if (isIgnoredSyncTriggerPath(doc.uri.fsPath)) {
        return;
      }
      // Stage 3.4 — a save recounts the file's workspace (detector); the
      // automatic push it used to fire under `full` is gone with the mode.
      if (!isAutoCheckEnabled(currentAutoSyncMode())) {
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
        const ms = resolveSaveDebounceMs(entry);
        const key = doc.uri.fsPath;
        const prev = saveTimers.get(key);
        if (prev !== undefined) {
          clearTimeout(prev.timer);
        }
        const arm = (): void => {
          const timer = setTimeout(() => {
            saveTimers.delete(key);
            serialize(() => recountWorkspaceStatus(folder.uri.fsPath, fileEntry.workspaceId));
          }, ms);
          saveTimers.set(key, { timer, rearm: arm });
        };
        arm();
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
      // v0.7 — `off` blocks all automatic activity. `check-only` falls
      // through to runFocusSyncAll which itself respects the mode.
      if (!isAutoCheckEnabled(currentAutoSyncMode())) {
        return;
      }
      const delay = vscode.workspace.getConfiguration(CFG).get<number>("syncOnFocusDelayMs", 3000);
      focusTimer = setTimeout(() => {
        focusTimer = undefined;
        if (!vscode.window.state.focused) {
          return;
        }
        serializeIn("full", async () => {
          if (syncSessionPause.isPaused()) {
            return;
          }
          if (syncAutoPause.isActive()) {
            await deps.statusBar.refresh();
            return;
          }
          await runFocusSyncAll();
        }, "focus-full-sync");
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
      // Stage 3.4 — opening a file recounts its workspace so the decoration
      // and the panel are fresh; the automatic pull is gone with `full`.
      if (!isAutoCheckEnabled(currentAutoSyncMode())) {
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
        serialize(() => recountWorkspaceStatus(folder.uri.fsPath, fileEntry.workspaceId));
      })();
    }),

    new vscode.Disposable(() => {
      for (const pending of saveTimers.values()) {
        clearTimeout(pending.timer);
      }
      saveTimers.clear();
      parkedPushes.clear();
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

/**
 * Recount every workspace whose tracked files a commit touched (stage 3.4).
 *
 * Replaces the old push-on-commit body, which resolved each committed path,
 * skipped binaries and pushed file by file. A recount needs none of that:
 * `checkWorkspaceStatus` covers the whole workspace, so this only maps
 * committed paths to workspace ids and deduplicates.
 */
async function recountCommittedWorkspaces(
  deps: SyncTriggerManagerDeps,
  workspaceFolderRoot: string,
  gitRepoRoot: string,
  committedRelToGit: string[],
  withEngine: (root: string, fn: (engine: SyncEngine) => Promise<void>) => Promise<void>,
): Promise<void> {
  const normFolder = workspaceFolderRoot.replace(/\\/g, "/").toLowerCase();
  const normGit = gitRepoRoot.replace(/\\/g, "/").toLowerCase();
  if (!normFolder.startsWith(normGit) && !normGit.startsWith(normFolder)) {
    return;
  }
  const cfg = await WorkspaceConfigManager.load(workspaceFolderRoot);
  const gc = await deps.globalConfig.load();
  const touchedWorkspaces = new Set<string>();
  for (const gitRel of committedRelToGit) {
    const abs = path.normalize(path.join(gitRepoRoot, gitRel.split("/").join(path.sep)));
    if (!abs.replace(/\\/g, "/").toLowerCase().startsWith(normFolder)) {
      continue;
    }
    let relW: string;
    try {
      relW = absoluteToTrackedPosix(workspaceFolderRoot, cfg.pathMapping, gc.machineName, abs);
    } catch {
      continue;
    }
    const fe = cfg.files.find((f) => f.localPath === relW);
    if (fe) {
      touchedWorkspaces.add(fe.workspaceId);
    }
  }
  if (touchedWorkspaces.size === 0) {
    return;
  }
  await withEngine(workspaceFolderRoot, async (engine) => {
    for (const wsId of touchedWorkspaces) {
      const fresh = await WorkspaceConfigManager.load(workspaceFolderRoot);
      const entry = fresh.activeWorkspaces.find((w) => w.workspaceId === wsId);
      if (!entry || normalizeWorkspaceSyncState(entry) !== "active") {
        continue;
      }
      await engine.checkWorkspaceStatus(wsId);
    }
  });
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
      repo.state.onDidChange(() => {
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
          // Stage 3.4 — a commit recounts the workspaces whose tracked files
          // it touched; the automatic push is gone with `full`. `pushOnCommit`
          // keeps its name but now only opts the recount in.
          if (!isAutoCheckEnabled(currentAutoSyncMode())) {
            return;
          }
          if (!vscode.workspace.getConfiguration(CFG).get<boolean>("pushOnCommit", false)) {
            return;
          }
          const relPaths = await gitFilesInCommit(repoRoot, head);
          if (relPaths.length === 0) {
            return;
          }
          if (syncAutoPause.isActive()) {
            return;
          }
          serialize(async () => {
            const folders = vscode.workspace.workspaceFolders ?? [];
            for (const folder of folders) {
              await recountCommittedWorkspaces(deps, folder.uri.fsPath, repoRoot, relPaths, withEngine);
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

