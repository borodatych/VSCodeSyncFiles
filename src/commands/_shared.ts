/**
 * Cross-module helpers for the `src/commands/` decomposition (v2.6).
 *
 * Pure UI helpers — no `runWithEngine`, no provider state, no module-level
 * mutable state. Each function takes only what it needs and reads
 * `WorkspaceConfigManager` directly. Both `extension.ts` and the per-area
 * command bundles import from here.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { resolveDefaultWorkspaceRootFsPath } from "../utils/workspaceRootResolver.js";
import { hasArchivedTag } from "../utils/workspaceLastActivity.js";
import type { ActiveWorkspaceEntry } from "../core/types.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";
import {
  mapTransitionRejection,
  transitionWorkspaceSyncState,
  type WorkspaceTransitionInput,
} from "../core/workspaceSuspendStateMachine.js";

/** Default first open VS Code folder; matches the legacy `pickRoot()` shim. */
export function pickRoot(): string | undefined {
  return resolveDefaultWorkspaceRootFsPath();
}

/** Pick a workspace from the local config: 0 → warn, 1 → auto-pick, N → QuickPick. */
export async function pickWorkspaceId(root: string): Promise<string | undefined> {
  const wc = await WorkspaceConfigManager.load(root);
  if (wc.activeWorkspaces.length === 0) {
    await vscode.window.showErrorMessage("Нет активных workspace — Create Workspace.");
    return undefined;
  }
  if (wc.activeWorkspaces.length === 1) {
    return wc.activeWorkspaces[0]?.workspaceId;
  }
  const picked = await vscode.window.showQuickPick(
    wc.activeWorkspaces.map((e) => ({
      label: `${e.workspaceNote} (${e.workspaceId})`,
      id: e.workspaceId,
    })),
    { placeHolder: "Выберите workspace" },
  );
  return picked?.id;
}

/** Pick a workspace from the local config, excluding the given one. */
export async function pickOtherWorkspaceId(
  root: string,
  excludeWorkspaceId: string,
): Promise<string | undefined> {
  const wc = await WorkspaceConfigManager.load(root);
  const candidates = wc.activeWorkspaces.filter((w) => w.workspaceId !== excludeWorkspaceId);
  if (candidates.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: нет другого workspace для перемещения.");
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0]?.workspaceId;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((e) => ({
      label: `${e.workspaceNote} (${e.workspaceId})`,
      id: e.workspaceId,
    })),
    { placeHolder: "Переместить в workspace" },
  );
  return picked?.id;
}

/** Same as `pickWorkspaceId` but filters candidates by a predicate first. */
export async function pickWorkspaceIdMatching(
  root: string,
  predicate: (e: ActiveWorkspaceEntry) => boolean,
  emptyWarn: string,
): Promise<string | undefined> {
  const wc = await WorkspaceConfigManager.load(root);
  const candidates = wc.activeWorkspaces.filter(predicate);
  if (candidates.length === 0) {
    await vscode.window.showWarningMessage(emptyWarn);
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0]?.workspaceId;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((e) => ({
      label: `${e.workspaceNote} (${e.workspaceId})`,
      id: e.workspaceId,
    })),
    { placeHolder: "Выберите workspace" },
  );
  return picked?.id;
}

export type WorkspaceTransitionValidation =
  | { ok: true; newState: "active" | "suspended" | "frozen" }
  | { ok: false; warning: string };

/** Validate a (workspace × transition action) move via the state machine.
 * Surfaces three categories of rejection: missing entry, archived tag (unless
 * `skipArchivedCheck`), or state-machine reject (already-in-state etc.). */
export async function validateWorkspaceTransition(
  root: string,
  workspaceId: string,
  action: WorkspaceTransitionInput,
  opts: { skipArchivedCheck?: boolean } = {},
): Promise<WorkspaceTransitionValidation> {
  const wc = await WorkspaceConfigManager.load(root);
  const ent = wc.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
  if (!ent) {
    return { ok: false, warning: "VSCodeSync: workspace не найден в vscodesync.json." };
  }
  if (!opts.skipArchivedCheck && hasArchivedTag(ent.tags)) {
    return { ok: false, warning: "VSCodeSync: сначала разархивируйте workspace (Unarchive)." };
  }
  const t = transitionWorkspaceSyncState(normalizeWorkspaceSyncState(ent), action);
  if (!t.ok) {
    return { ok: false, warning: mapTransitionRejection(action, t.reason) };
  }
  return { ok: true, newState: t.newState };
}
