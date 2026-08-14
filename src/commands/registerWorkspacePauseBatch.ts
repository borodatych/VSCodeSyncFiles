/**
 * Batch pause/resume: `vscodesync.suspendWorkspaces` and
 * `vscodesync.resumeWorkspaces`.
 *
 * The single-workspace commands stay where they are — this pair exists for the
 * case that made pausing worth having at all: jumping between git branches in a
 * repo whose folder holds several workspaces. Pausing them one by one from the
 * tree is the same decision repeated N times, and the Nth is the one that gets
 * forgotten.
 *
 * Resume additionally recounts statuses: a paused workspace stops updating
 * them (see `SyncEngine.checkWorkspaceStatus`), so without a detector pass the
 * tree would keep showing whatever the checkout left behind.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { normalizeWorkspaceSyncState, type ActiveWorkspaceEntry } from "../core/types.js";
import { hasArchivedTag } from "../utils/workspaceLastActivity.js";
import { describePauseBatchOutcome, type PauseBatchOutcome } from "../core/workspacePauseBatch.js";
import { warnLog } from "../utils/log.js";
import { pickRoot, validateWorkspaceTransition } from "./_shared.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

export interface WorkspacePauseBatchDeps {
  runWithEngine: RunWithEngineFn;
  refreshUi: () => void | Promise<void>;
}

interface PickItem extends vscode.QuickPickItem {
  workspaceId: string;
}

function toItems(entries: readonly ActiveWorkspaceEntry[]): PickItem[] {
  return entries.map((e) => ({
    label: e.workspaceNote.trim() || e.workspaceId,
    description: e.workspaceId.slice(0, 8),
    ...(e.gitBranch === undefined || e.gitBranch === ""
      ? {}
      : { detail: `git-ветка: ${e.gitBranch}` }),
    workspaceId: e.workspaceId,
    // Pre-ticked: the branch-switch case wants all of them, and un-ticking the
    // odd one out is less work than ticking eight.
    picked: true,
  }));
}

async function runBatch(
  deps: WorkspacePauseBatchDeps,
  action: "suspend" | "resume",
): Promise<void> {
  const root = pickRoot();
  if (!root) {
    return;
  }
  const wanted = action === "suspend" ? "active" : "suspended";
  const wc = await WorkspaceConfigManager.load(root);
  const candidates = wc.activeWorkspaces.filter(
    (e) => normalizeWorkspaceSyncState(e) === wanted && !hasArchivedTag(e.tags),
  );
  if (candidates.length === 0) {
    await vscode.window.showInformationMessage(
      action === "suspend"
        ? "VSCodeSync: нет активных воркспейсов, которые можно приостановить."
        : "VSCodeSync: нет приостановленных воркспейсов.",
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(toItems(candidates), {
    canPickMany: true,
    placeHolder:
      action === "suspend"
        ? "Какие воркспейсы приостановить (синхронизация и статусы замрут)"
        : "Какие воркспейсы возобновить (статусы будут пересчитаны)",
  });
  if (!picked || picked.length === 0) {
    return;
  }

  const outcome: PauseBatchOutcome = { applied: 0, skipped: [] };
  const notes = new Map(candidates.map((e) => [e.workspaceId, e.workspaceNote.trim() || e.workspaceId]));

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: action === "suspend" ? "VSCodeSync · Приостановка" : "VSCodeSync · Возобновление",
      cancellable: false,
    },
    async () => {
      await deps.runWithEngine(
        async (engine) => {
          for (const item of picked) {
            const note = notes.get(item.workspaceId) ?? item.workspaceId;
            const v = await validateWorkspaceTransition(root, item.workspaceId, action);
            if (!v.ok) {
              outcome.skipped.push({ note, reason: v.warning.replace(/^VSCodeSync:\s*/, "") });
              continue;
            }
            try {
              await engine.setWorkspaceSyncState(item.workspaceId, v.newState);
              // A hand-made decision in either direction must not look like an
              // automatic one, or the branch watcher would undo it later.
              await engine.setWorkspaceBranchPauseState(item.workspaceId, {
                autoPausedFromBranch: null,
              });
              if (action === "resume") {
                await engine.checkWorkspaceStatus(item.workspaceId);
              }
              outcome.applied += 1;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              outcome.skipped.push({ note, reason: msg });
              warnLog("pauseBatch", `${action} ${item.workspaceId}: ${msg}`);
            }
          }
        },
        root,
        { showErrorDialog: false, trigger: "user" },
      );
    },
  );

  await deps.refreshUi();
  void vscode.window.showInformationMessage(describePauseBatchOutcome(action, outcome));
}

export function registerWorkspacePauseBatchCommands(
  deps: WorkspacePauseBatchDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vscodesync.suspendWorkspaces", () => runBatch(deps, "suspend")),
    vscode.commands.registerCommand("vscodesync.resumeWorkspaces", () => runBatch(deps, "resume")),
  ];
}
