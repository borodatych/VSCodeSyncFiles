/**
 * Registers VS Code Tasks of type {@link VSCODESYNC_TASK_TYPE} (`tasks.json` → `"type": "vscodesync"`).
 */

import * as vscode from "vscode";
import type { SyncEngine } from "../core/syncEngine.js";
import { createWorkspaceSnapshot } from "../core/snapshotsEngine.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { resolveDefaultWorkspaceRootFsPath } from "../utils/workspaceRootResolver.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";

export const VSCODESYNC_TASK_TYPE = "vscodesync" as const;

export type VscodeSyncTaskKind = "push" | "pull" | "push-all" | "pull-all" | "create-snapshot";

export interface VscodeSyncTaskDefinition extends vscode.TaskDefinition {
  readonly type: typeof VSCODESYNC_TASK_TYPE;
  /** Sync operation — roadmap 08-platform §8.3 */
  readonly task: VscodeSyncTaskKind;
  /** Cloud workspace ID; omit if only one workspace is configured in this folder. */
  readonly workspace?: string;
  /** POSIX path for single-file `push` / `pull` (optional). */
  readonly file?: string;
  /** Snapshot name for `create-snapshot`. */
  readonly snapshotName?: string;
}

export interface VscodeSyncTaskProviderDeps {
  runWithEngine: (
    fn: (engine: SyncEngine, root: string, gc: GlobalConfigManager) => Promise<void>,
    workspaceRoot?: string,
    options?: { showErrorDialog?: boolean },
  ) => Promise<void>;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
}

function posixRelFromTask(rel: string | undefined): string | undefined {
  if (rel === undefined || rel.trim() === "") {
    return undefined;
  }
  return rel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function workspaceFolderMatchingScope(
  scope: vscode.TaskScope | vscode.WorkspaceFolder,
): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find((f) => f === scope);
}

function workspaceFolderUri(scope: vscode.TaskScope | vscode.WorkspaceFolder): vscode.Uri | undefined {
  const matched = workspaceFolderMatchingScope(scope);
  if (matched) {
    const u = matched.uri;
    return u.scheme === "file" ? u : undefined;
  }
  const fb = resolveDefaultWorkspaceRootFsPath();
  return fb ? vscode.Uri.file(fb) : undefined;
}

async function resolveWorkspaceId(root: string, requested: string | undefined): Promise<string | undefined> {
  const wc = await WorkspaceConfigManager.load(root);
  if (wc.activeWorkspaces.length === 0) {
    return undefined;
  }
  if (requested?.trim()) {
    const id = requested.trim();
    const hit = wc.activeWorkspaces.find((w) => w.workspaceId === id);
    return hit?.workspaceId;
  }
  if (wc.activeWorkspaces.length === 1) {
    return wc.activeWorkspaces[0]?.workspaceId;
  }
  return undefined;
}

/** Exit codes aligned with CLI roadmap; Pseudoterminal `onDidClose` uses positive codes. */
class TaskExit extends Error {
  constructor(
    readonly exitCode: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "TaskExit";
  }
}

/** Run one task definition; throws {@link TaskExit} for deterministic exit codes. */
async function runVscodeSyncTask(
  deps: VscodeSyncTaskProviderDeps,
  def: VscodeSyncTaskDefinition,
  scope: vscode.TaskScope | vscode.WorkspaceFolder,
): Promise<void> {
  const folderUri = workspaceFolderUri(scope);
  const root = folderUri?.fsPath;
  if (!root) {
    throw new TaskExit(4, "No workspace folder.");
  }

  const kind = def.task;

  switch (kind) {
    case "push-all":
    case "pull-all": {
      await deps.runWithEngine(
        async (engine, r) => {
          const wsHint = await resolveWorkspaceId(r, def.workspace);
          const wsAsked = Boolean(def.workspace?.trim());
          if (!wsAsked && (await WorkspaceConfigManager.load(r)).activeWorkspaces.length > 1) {
            throw new TaskExit(
              4,
              `Multiple workspaces — set "workspace" in the task (${VSCODESYNC_TASK_TYPE}).`,
            );
          }
          if (wsAsked && !wsHint) {
            throw new TaskExit(4, "Workspace ID not found in this folder.");
          }
          if (kind === "push-all") {
            await engine.pushAll(wsHint);
            return;
          }
          await engine.pullAll(wsHint);
        },
        root,
        { showErrorDialog: false },
      );
      return;
    }

    case "push":
    case "pull": {
      const wsId = await resolveWorkspaceId(root, def.workspace);
      if (!wsId) {
        const ambiguous = (await WorkspaceConfigManager.load(root)).activeWorkspaces.length > 1;
        throw new TaskExit(
          4,
          ambiguous ? `Specify "workspace" (multiple workspaces in folder).` : "No active workspace.",
        );
      }

      const filePosix = posixRelFromTask(def.file);
      await deps.runWithEngine(
        async (engine, r) => {
          const cfg = await WorkspaceConfigManager.load(r);
          const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === wsId);
          if (!entry) {
            throw new TaskExit(4, "Workspace ID not linked to this folder.");
          }
          if (filePosix !== undefined) {
            if (kind === "push") {
              await engine.pushFile(cfg, wsId, filePosix, entry);
            } else {
              await engine.pullFile(cfg, wsId, filePosix, entry);
            }
            return;
          }
          if (kind === "push") {
            await engine.pushAll(wsId);
            return;
          }
          await engine.pullAll(wsId);
        },
        root,
        { showErrorDialog: false },
      );
      return;
    }

    case "create-snapshot": {
      if (!(await assertWorkspaceTrusted())) {
        throw new TaskExit(1, "Workspace Trust required.");
      }
      const name = typeof def.snapshotName === "string" ? def.snapshotName.trim() : "";
      if (!name) {
        throw new TaskExit(4, "Set snapshotName on the task (create-snapshot).");
      }
      const wsId = await resolveWorkspaceId(root, def.workspace);
      if (!wsId) {
        const ambiguous = (await WorkspaceConfigManager.load(root)).activeWorkspaces.length > 1;
        throw new TaskExit(
          4,
          ambiguous ? "Specify workspace for snapshot (multiple workspaces)." : "No active workspace.",
        );
      }

      await deps.runWithEngine(
        async (_, r, gc) => {
          const provider = await deps.tryAuthenticatedProvider();
          if (!provider) {
            throw new TaskExit(2, "No authenticated cloud provider.");
          }
          await createWorkspaceSnapshot(provider, r, wsId, name, (await gc.load()).machineName);
        },
        root,
        { showErrorDialog: false },
      );
      return;
    }

    default: {
      const _exhaustive: never = kind;
      throw new TaskExit(1, `Unknown task ${String(_exhaustive)}`);
    }
  }
}

export function registerVscodeSyncTaskProvider(context: vscode.ExtensionContext, deps: VscodeSyncTaskProviderDeps): void {
  const provider: vscode.TaskProvider = {
    provideTasks(): vscode.ProviderResult<vscode.Task[]> {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        return [];
      }
      // v0.17 D05 — surface the additional task kinds documented in
      // `core/vscodeTaskDefinitions.ts` so users can wire them from
      // `tasks.json`. `create-snapshot` is already handled by the inner
      // runner; new kinds (repair-manifest, support-bundle) execute the
      // corresponding registered command.
      const defs: readonly VscodeSyncTaskDefinition[] = [
        { type: VSCODESYNC_TASK_TYPE, task: "pull-all" },
        { type: VSCODESYNC_TASK_TYPE, task: "push-all" },
        { type: VSCODESYNC_TASK_TYPE, task: "create-snapshot" },
      ];
      const out: vscode.Task[] = [];
      const multi = folders.length > 1;
      for (const folder of folders) {
        for (const d of defs) {
          const labelSuffix = multi ? ` (${folder.name})` : "";
          const t = buildTask(deps, d, folder, `${d.task}${labelSuffix}`);
          if (t) {
            out.push(t);
          }
        }
      }
      return out;
    },

    resolveTask(task: vscode.Task): vscode.ProviderResult<vscode.Task> {
      return resolveInner(deps, task);
    },
  };

  context.subscriptions.push(vscode.tasks.registerTaskProvider(VSCODESYNC_TASK_TYPE, provider));
}

function buildTask(
  deps: VscodeSyncTaskProviderDeps,
  def: VscodeSyncTaskDefinition,
  scope: vscode.TaskScope | vscode.WorkspaceFolder,
  displayLabel?: string,
): vscode.Task | undefined {
  const trimmedOpt = typeof displayLabel === "string" ? displayLabel.trim() : "";
  const label = trimmedOpt.length > 0 ? trimmedOpt : def.task;

  const execution = new vscode.CustomExecution(() => {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number>();

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        const run = async (): Promise<void> => {
          const line = (s: string): void => {
            writeEmitter.fire(`${s}\r\n`);
          };
          try {
            line("VSCodeSync: " + label);
            await runVscodeSyncTask(deps, def, scope);
            line(`Done (${def.task}).`);
            closeEmitter.fire(0);
          } catch (e) {
            if (e instanceof TaskExit) {
              line(e.detail);
              closeEmitter.fire(e.exitCode === 0 ? 1 : e.exitCode);
              return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            const code =
              e instanceof Error && /нет авторизованного|not authenticated|authenticate|401|403/i.test(msg)
                ? 2
                : 1;
            line(msg);
            closeEmitter.fire(code);
          }
        };
        void run();
      },
      close: () => {
        return undefined;
      },
    };
    return Promise.resolve(pty);
  });

  try {
    const task = new vscode.Task(def, scope, label, VSCODESYNC_TASK_TYPE, execution);
    task.presentationOptions.reveal = vscode.TaskRevealKind.Always;
    task.presentationOptions.echo = false;
    task.presentationOptions.showReuseMessage = false;
    return task;
  } catch {
    return undefined;
  }
}

function resolveInner(deps: VscodeSyncTaskProviderDeps, task: vscode.Task): vscode.ProviderResult<vscode.Task> {
  const defRaw = task.definition as Partial<VscodeSyncTaskDefinition>;
  if (defRaw.type !== VSCODESYNC_TASK_TYPE || !defRaw.task) {
    return undefined;
  }

  const tkStr = defRaw.task as string;

  let taskKind: VscodeSyncTaskKind | undefined;
  if (
    tkStr === "push" ||
    tkStr === "pull" ||
    tkStr === "push-all" ||
    tkStr === "pull-all" ||
    tkStr === "create-snapshot"
  ) {
    taskKind = tkStr;
  }

  if (taskKind === undefined) {
    return undefined;
  }

  const def: VscodeSyncTaskDefinition = {
    type: VSCODESYNC_TASK_TYPE,
    task: taskKind,
    ...(defRaw.workspace !== undefined ? { workspace: defRaw.workspace } : {}),
    ...(defRaw.file !== undefined ? { file: defRaw.file } : {}),
    ...(defRaw.snapshotName !== undefined ? { snapshotName: defRaw.snapshotName } : {}),
  };

  let scopeWs: vscode.TaskScope | vscode.WorkspaceFolder =
    vscode.TaskScope.Workspace;
  const matched = task.scope !== undefined ? workspaceFolderMatchingScope(task.scope) : undefined;
  if (matched) {
    scopeWs = matched;
  }
  const name =
    typeof task.name === "string" && task.name.trim().length > 0
      ? task.name.trim()
      : def.task;
  return buildTask(deps, def, scopeWs, name);
}
