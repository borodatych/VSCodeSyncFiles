/**
 * v2.6.7 — restore persisted Workspaces tree filters.
 *
 * Each VS Code window keeps four globalState keys for the Workspaces tree:
 *
 *   - `WORKSPACES_NOTE_FILTER_KEY` — last typed substring filter.
 *   - `WORKSPACES_TAG_FILTERS_KEY` — `string[]` of selected tags.
 *   - `WORKSPACES_SHOW_ARCHIVED_KEY` — boolean toggle.
 *   - `WORKSPACES_CANONICAL_MODE_KEY` — which path space the file tree groups
 *     by; absent means the default (the workspace's own structure).
 *
 * On activate the extension reads these and seeds the tree provider so the
 * filter chip / archive visibility survives a window restart. Pure shape
 * validation of the tag-list payload (`unknown` → `string[]`) lives here so
 * `extension.ts` doesn't carry that one-liner.
 */
import type * as vscode from "vscode";
import {
  WORKSPACES_CANONICAL_MODE_KEY,
  WORKSPACES_NOTE_FILTER_KEY,
  WORKSPACES_SHOW_ARCHIVED_KEY,
  WORKSPACES_TAG_FILTERS_KEY,
} from "../ui/workspacesTreeFilterState.js";
import type { WorkspacesTreeProvider } from "../ui/workspacesTree.js";

export function restoreWorkspacesTreeFilters(
  context: vscode.ExtensionContext,
  workspacesTree: WorkspacesTreeProvider,
): void {
  const savedNoteFilter = context.globalState.get<string>(WORKSPACES_NOTE_FILTER_KEY) ?? "";
  workspacesTree.setNoteFilter(savedNoteFilter);

  const savedTagFilters = context.globalState.get<unknown>(WORKSPACES_TAG_FILTERS_KEY);
  const tagList = sanitiseTagList(savedTagFilters);
  workspacesTree.setTagFilters(tagList);

  workspacesTree.setShowArchived(context.globalState.get(WORKSPACES_SHOW_ARCHIVED_KEY) === true);

  // Absent key ⇒ keep the default (workspace structure). Only an explicit
  // `false` switches the tree back to this machine's placement.
  workspacesTree.setCanonicalMode(context.globalState.get(WORKSPACES_CANONICAL_MODE_KEY) !== false);
}

export function sanitiseTagList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((x): x is string => typeof x === "string");
}
