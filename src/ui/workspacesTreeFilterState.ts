/**
 * Persistent filter state for the Workspaces tree view (note query, tag
 * filters, show-archived flag).
 *
 * Carved out of `extension.ts` so the activate-time restore (executes once
 * at startup, before any commands register) and the per-command updates
 * (registerViewManagement / treeWorkspaceAddTagToPanelFilter) share a
 * single source of constants + chrome helpers.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { WorkspacesTreeProvider, SyncTreeElement } from "./workspacesTree.js";

export const WORKSPACES_NOTE_FILTER_KEY = "vscodesync.workspacesNoteFilter";
export const WORKSPACES_TAG_FILTERS_KEY = "vscodesync.workspacesTagFilters";
export const WORKSPACES_SHOW_ARCHIVED_KEY = "vscodesync.workspacesShowArchived";

/** Walk every open VS Code folder and gather a sorted union of tags from
 * the cached `vscodesync.json` entries. Case-insensitive dedup. */
export async function collectAllWorkspaceTags(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const seen = new Map<string, string>();
  for (const folder of folders) {
    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
    for (const e of wc.activeWorkspaces) {
      for (const t of e.tags ?? []) {
        const trim = t.trim();
        if (!trim) {
          continue;
        }
        const low = trim.toLowerCase();
        if (!seen.has(low)) {
          seen.set(low, trim);
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/** Sync the tree-view's `description` chrome and the
 * `vscodesync.workspacesFilterActive` when-context with current filter
 * state. Cheap — just string formatting + one setContext call. */
export async function applyWorkspacesTreeFilterChrome(
  treeView: vscode.TreeView<SyncTreeElement>,
  provider: WorkspacesTreeProvider,
): Promise<void> {
  const q = provider.getNoteFilter().trim();
  const tags = [...provider.getTagFilters()];
  const parts: string[] = [];
  if (q.length > 0) {
    const short = q.length > 36 ? `${q.slice(0, 33)}…` : q;
    parts.push(`🔍 ${short}`);
  }
  if (tags.length > 0) {
    parts.push(tags.map((t) => `#${t.replace(/\s+/g, "_")}`).join(" "));
  }
  if (provider.getShowArchived()) {
    parts.push("+archived");
  }
  const desc = parts.join(" · ");
  treeView.description = desc.length > 0 ? desc.slice(0, 120) : undefined;
  await vscode.commands.executeCommand(
    "setContext",
    "vscodesync.workspacesFilterActive",
    q.length > 0 || tags.length > 0,
  );
}
